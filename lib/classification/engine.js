'use strict';

/**
 * THE classification engine. One entry point, classifyTrack(), used for every track:
 * the worker calls it for jobs enqueued by new uploads AND by the historical backfill,
 * and the admin "reclassify" actions go through the same queue. There is no second path.
 *
 *   load track -> parse title/version -> legacy label + lyrics-script rules
 *     -> external providers (concurrent, each isolated) -> aggregate per label
 *     -> thresholds -> persist (never over manual labels) -> outcome for the job
 */
const taxonomy = require('./taxonomy');
const { DIMENSIONS } = taxonomy;
const { sanitize, splitArtists, parseTitle, compositionKey } = require('./text');
const { titleObservations, legacyObservations, languageObservations } = require('./rules');
const { aggregate, decideStatus, sourceOf } = require('./evidence');
const { runProvider } = require('./providers/base');
const { cacheKey: lyricsKey } = require('../lyricsProviders');

const STATUS_RANK = { approved: 3, provisional: 2, needs_review: 1 };
const COMPOSITION_DIMS = new Set(['genre', 'language']);
const dimOf = (key) => key.split(':')[0];
const slugOf = (key) => key.split(':').slice(1).join(':');

function buildTrack(row) {
  const title = sanitize(row.title);
  const parsed = parseTitle(title, { album: row.albumName });
  const artistRaw = sanitize(row.artist_or_narrator);
  return {
    id: row.id, title, artistRaw, parsed,
    base: parsed.base || title,
    artists: splitArtists(artistRaw),
    album: sanitize(row.albumName) || null,
    albumYear: row.albumYear || null,
    durationSec: row.duration_seconds || null,
    // Only markers on the track itself (not an album-level hint) decide whether a provider record is "the same version".
    versionSlugs: new Set(parsed.versions.filter((v) => v.via !== 'album').map((v) => v.slug)),
    legacyName: row.category || null
  };
}

function createEngine({ store, config, providers, http, cache, stats, breaker, llmClassify, audioLink, invalidateMediaItem = () => {}, log = () => {}, lyricsKeyFn = lyricsKey }) {
  const ctxBase = { config, http, cache, stats, breaker, log, llmClassify, audioLink };

  function bestStatus(statuses) {
    let best = null;
    for (const s of statuses) if (s && (STATUS_RANK[s] || 0) > (STATUS_RANK[best] || 0)) best = s;
    return best;
  }

  /**
   * opts: { dimensions?: string[] (only write these), dryRun?: boolean }
   * Returns { outcome, retry, labels, dimensionStatus, overallStatus, providerErrors, ... }.
   * Throws only for infrastructure problems the job runner should retry (e.g. database down).
   */
  async function classifyTrack(trackId, { dimensions = null, dryRun = false } = {}) {
    const startedAt = Date.now();
    const row = await store.loadTrack(trackId);
    if (!row) return { outcome: 'cancelled', retry: false, reason: 'track no longer exists', labels: [], providerErrors: [] };
    if (row.type !== 'music') return { outcome: 'cancelled', retry: false, reason: `not music content (type=${row.type})`, labels: [], providerErrors: [] };

    const track = buildTrack(row);
    const idx = await store.loadLabels();
    if (!idx.byKey.size) throw new Error('music_labels is empty: run supabase/seed_music_labels.sql (or `node scripts/classification-cli.js seed-taxonomy`)');
    const wanted = dimensions && dimensions.length ? new Set(dimensions) : new Set(DIMENSIONS);

    /* --- observations that need no network --- */
    const observations = [
      ...titleObservations(track.parsed),
      ...legacyObservations(track.legacyName)
    ];
    const lyrics = track.artists.length || track.base ? await store.loadLyrics(lyricsKeyFn(track.title, track.artistRaw)) : null;
    observations.push(...languageObservations({ title: track.base, album: track.album, artist: track.artistRaw, lyrics }));

    /* --- external providers, concurrently, each isolated --- */
    const active = providers.filter((p) => p.isConfigured(config));
    const needsArtist = new Set(['musicbrainz', 'spotify', 'lastfm']);
    const results = await Promise.all(active.map(async (p) => {
      if (needsArtist.has(p.name) && !track.artists.length) {
        return { provider: p.name, ok: true, result: { observations: [], meta: {}, source: null, note: 'track has no artist: skipped (no title-only matching)' } };
      }
      if (p.name === 'audio' && [...wanted].every((d) => d === 'version')) {
        return { provider: p.name, ok: true, result: { observations: [], meta: {}, source: null, note: 'audio not needed for the requested dimensions' } };
      }
      return runProvider(p, track, { ...ctxBase });
    }));

    const providerErrors = results.filter((r) => !r.ok).map((r) => ({ provider: r.provider, kind: r.error.kind, retryable: r.error.retryable, retryAfterMs: r.error.retryAfterMs || 0, message: r.error.message }));
    const meta = {};
    const sources = [];
    for (const r of results) {
      if (!r.ok) continue;
      for (const o of r.result.observations) {
        // Borrowed from a different version of the song: only composition-level facts may cross over.
        if (o.scope === 'composition' && !COMPOSITION_DIMS.has(dimOf(o.key))) continue;
        observations.push(o);
      }
      Object.assign(meta, Object.fromEntries(Object.entries(r.result.meta || {}).filter(([, v]) => v != null)));
      if (r.result.source) sources.push({ provider: r.provider, ...r.result.source });
    }

    /* --- aggregate -> per-label decisions --- */
    const agg = aggregate(observations.filter((o) => idx.byKey.has(o.key)), config);
    const decided = new Map();
    for (const [key, entry] of agg) {
      const status = decideStatus(entry, config);
      if (status) decided.set(key, { ...entry, status });
    }
    // Keep the most specific genre, but only where it is as well supported as the broader genre above it.
    // A child's evidence always counts for its ancestors too, so an ancestor can end up MORE trusted than the
    // child (e.g. Indian Film Music corroborated by two sources, "Bollywood Romantic" guessed by one). Then the
    // broader, better-supported label is kept and the weaker specific one is not stored.
    const losers = new Set();
    for (const [key, d] of decided) {
      for (const a of taxonomy.ancestorsOf(key)) {
        const anc = decided.get(a);
        if (!anc) continue;
        // A child that is itself provisional or better keeps its place; a merely-suggested (needs_review) child
        // gives way to a better-supported ancestor.
        const childRank = STATUS_RANK[d.status] || 0;
        if (childRank >= STATUS_RANK.provisional || childRank >= (STATUS_RANK[anc.status] || 0)) losers.add(a); else losers.add(key);
      }
    }
    for (const k of losers) decided.delete(k);

    /* --- merge with what is already stored (manual labels always win) --- */
    const existing = await store.loadTrackLabels(trackId);
    const existingByKey = new Map(existing.map((r) => [r.label.key, r]));
    const finalByDim = Object.fromEntries(DIMENSIONS.map((d) => [d, []]));
    for (const r of existing) if (r.status !== 'rejected') finalByDim[r.label.dimension].push({ key: r.label.key, status: r.status, confidence: Number(r.confidence), manual: r.is_manual });
    const toWrite = [];
    for (const [key, d] of decided) {
      const ex = existingByKey.get(key);
      if (ex?.is_manual) continue; // human decision (add / approve / reject / remove) is final
      const dim = dimOf(key);
      const bucket = finalByDim[dim];
      const at = bucket.findIndex((b) => b.key === key);
      if (at >= 0) bucket.splice(at, 1);
      bucket.push({ key, status: d.status, confidence: d.confidence, manual: false });
      if (wanted.has(dim)) toWrite.push({ key, entry: d, existing: ex || null });
    }

    const dimensionStatus = {};
    for (const dim of DIMENSIONS) dimensionStatus[dim] = bestStatus(finalByDim[dim].map((b) => b.status)) || 'unknown';

    /* --- outcome --- */
    const required = config.requiredDimensions;
    const reqStatuses = required.map((d) => dimensionStatus[d]);
    const allApproved = reqStatuses.every((s) => s === 'approved');
    const anyApproved = reqStatuses.some((s) => s === 'approved');
    const anyCandidate = reqStatuses.some((s) => s !== 'unknown');
    const retryableErrors = providerErrors.filter((e) => e.retryable);
    const everyProviderFailed = active.length > 0 && providerErrors.length === active.length;

    let outcome; let overallStatus;
    if (allApproved) { outcome = 'completed'; overallStatus = 'complete'; }
    else if (anyApproved) { outcome = 'partially_completed'; overallStatus = 'partial'; }
    else if (anyCandidate) { outcome = 'needs_review'; overallStatus = 'needs_review'; }
    else if (everyProviderFailed) { outcome = 'failed'; overallStatus = 'failed'; }
    else { outcome = 'needs_review'; overallStatus = 'unclassified'; }
    // Missing sources may fill the gaps later: ask the runner to retry while attempts remain.
    const retry = outcome !== 'completed' && retryableErrors.length > 0;

    const labels = [...decided.values()].map((d) => ({
      key: d.key, name: taxonomy.get(d.key).name, dimension: dimOf(d.key), confidence: d.confidence, status: d.status,
      source: sourceOf(d), independentGroups: d.groups.length
    }));

    const result = { trackId, outcome, retry, overallStatus, dimensionStatus, labels, providerErrors, matched: meta, lyricsUsed: Boolean(lyrics), tookMs: Date.now() - startedAt, dryRun };
    if (dryRun) return { ...result, evidence: Object.fromEntries([...decided].map(([k, d]) => [k, d.groups])) };

    /* --- persist --- */
    const counts = { inserted: 0, updated: 0, unchanged: 0, locked: 0 };
    for (const w of toWrite) {
      const label = idx.byKey.get(w.key);
      const evidence = {
        engineVersion: config.version, computedAt: new Date().toISOString(),
        rawP: w.entry.rawP, competitorP: w.entry.competitorP, independentGroups: w.entry.groups.length,
        observations: w.entry.groups.map((g) => ({ group: g.group, p: g.p, scope: g.scope, notes: g.notes.slice(0, 3) }))
      };
      counts[await store.writeAutoLabel(trackId, { labelId: label.id, confidence: w.entry.confidence, status: w.entry.status, source: sourceOf(w.entry), evidence }, w.existing)]++;
    }
    for (const s of sources) await store.saveSource(trackId, s.provider, s);

    const topOf = (dim) => finalByDim[dim].filter((b) => b.status === 'approved').sort((a, b) => b.confidence - a.confidence)[0];
    // version_type = the track's main version: the strongest non-original marker, else Original (if it is at least provisional).
    const byStrength = (a, b) => (STATUS_RANK[b.status] - STATUS_RANK[a.status]) || (b.confidence - a.confidence);
    const usable = finalByDim.version.filter((b) => b.status === 'approved' || b.status === 'provisional');
    const versionTop = usable.filter((b) => b.key !== 'version:original').sort(byStrength)[0] || usable.find((b) => b.key === 'version:original');
    await store.saveMetadata(trackId, {
      ...meta,
      detected_language: topOf('language') ? slugOf(topOf('language').key) : null,
      version_type: versionTop ? slugOf(versionTop.key) : null,
      composition_key: compositionKey(track.base),
      original_title: track.base,
      match_confidence: sources.length ? Math.max(...sources.map((s) => s.matchConfidence || 0)) || null : null,
      classification_version: config.version,
      overall_status: overallStatus,
      dimension_status: dimensionStatus,
      last_classified_at: new Date().toISOString()
    });

    // Keep the legacy content_label_id / category in step (only ever fills an empty one).
    const legacyCandidate = (finalByDim.genre || []).filter((b) => b.status === 'approved' && taxonomy.legacyNameForKey(b.key)).sort((a, b) => b.confidence - a.confidence)[0];
    if (legacyCandidate && await store.syncLegacyLabel(trackId, taxonomy.legacyNameForKey(legacyCandidate.key))) invalidateMediaItem(trackId);

    log('info', 'classified', { trackId, outcome, overallStatus, labels: labels.length, ...counts, providerErrors: providerErrors.length, ms: result.tookMs });
    return { ...result, writes: counts };
  }

  return { classifyTrack, buildTrack };
}

module.exports = { createEngine, buildTrack };
