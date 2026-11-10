'use strict';

/**
 * Data access for the classification engine (Supabase JS client, like the rest of
 * the backend). Writes are per-row and idempotent; the unique constraints in
 * migration_music_classification.sql make concurrent writers safe, and every
 * update to a label row is conditional on is_manual = false, so a label a human
 * added, approved, rejected or removed can never be overwritten by the engine.
 */
const taxonomy = require('./taxonomy');

const MANUAL_SOURCE = 'manual';
const isDup = (e) => e && (e.code === '23505' || /duplicate key/i.test(e.message || ''));
const check = (error, what) => { if (error) throw new Error(`${what}: ${error.message}`); };

function createStore(supabase, { now = () => new Date() } = {}) {
  const iso = () => now().toISOString();
  let labelIndex = null; // { byKey: Map, byId: Map, at }

  /* ----------------------------------------------------------- taxonomy */

  async function loadLabels({ force = false } = {}) {
    if (!force && labelIndex && Date.now() - labelIndex.at < 5 * 60 * 1000) return labelIndex;
    const { data, error } = await supabase.from('music_labels').select('*');
    check(error, 'load music_labels');
    const byKey = new Map(); const byId = new Map();
    for (const l of data || []) { const e = { ...l, key: taxonomy.keyOf(l.dimension, l.slug) }; byKey.set(e.key, e); byId.set(l.id, e); }
    labelIndex = { byKey, byId, at: Date.now() };
    return labelIndex;
  }

  /** Idempotent: inserts missing labels (parents first) and repairs hierarchy. Returns number inserted. */
  async function ensureTaxonomy() {
    let idx = await loadLabels({ force: true });
    let inserted = 0;
    for (const l of taxonomy.ALL_LABELS) { // parents are listed before children
      const key = taxonomy.keyOf(l.dimension, l.slug);
      const parent = l.parent ? idx.byKey.get(taxonomy.keyOf(l.dimension, l.parent)) : null;
      const have = idx.byKey.get(key);
      if (!have) {
        const { error } = await supabase.from('music_labels').insert({
          name: l.name, slug: l.slug, dimension: l.dimension, parent_id: parent?.id || null,
          description: l.description || null, legacy_name: l.legacy || null
        });
        if (error && !isDup(error)) throw new Error(`seed label ${key}: ${error.message}`);
        if (!error) inserted++;
        idx = await loadLabels({ force: true });
      } else if (l.parent && have.parent_id !== parent?.id) {
        await supabase.from('music_labels').update({ parent_id: parent?.id || null, updated_at: iso() }).eq('id', have.id);
      }
    }
    await loadLabels({ force: true });
    return inserted;
  }

  /* ------------------------------------------------------------- reads */

  async function loadTrack(id) {
    const { data: m, error } = await supabase.from('media_items')
      .select('id, type, title, artist_or_narrator, album_or_series, album_id, duration_seconds, category, content_label_id, storage_path')
      .eq('id', id).maybeSingle();
    check(error, 'load track');
    if (!m) return null;
    let album = null;
    if (m.album_id) {
      const r = await supabase.from('albums').select('name, release_year').eq('id', m.album_id).maybeSingle();
      album = r.data || null;
    }
    return { ...m, albumName: album?.name || m.album_or_series || null, albumYear: album?.release_year || null };
  }

  async function loadLyrics(key) {
    try {
      const { data, error } = await supabase.from('lyrics_cache').select('payload').eq('key', key).maybeSingle();
      if (error || !data?.payload) return null;
      const p = data.payload;
      return typeof p.plain_lyrics === 'string' && p.plain_lyrics ? p.plain_lyrics : (Array.isArray(p.timed_lyrics) ? p.timed_lyrics.map((l) => l.text).join('\n') : null);
    } catch (_) { return null; }
  }

  async function loadTrackLabels(musicId) {
    const idx = await loadLabels();
    const { data, error } = await supabase.from('music_track_labels').select('*').eq('music_id', musicId);
    check(error, 'load track labels');
    return (data || []).map((r) => ({ ...r, label: idx.byId.get(r.label_id) || null })).filter((r) => r.label);
  }

  async function getMetadata(musicId) {
    const { data, error } = await supabase.from('music_classification_metadata').select('*').eq('music_id', musicId).maybeSingle();
    check(error, 'load classification metadata');
    return data || null;
  }

  async function loadSources(musicId) {
    const { data, error } = await supabase.from('music_classification_sources').select('*').eq('music_id', musicId);
    check(error, 'load sources');
    return data || [];
  }

  /* ------------------------------------------------------------ writes */

  /**
   * Writes one automatic label. Returns 'inserted' | 'updated' | 'unchanged' | 'locked'.
   * Never deletes anything and never touches a manual row.
   */
  async function writeAutoLabel(musicId, { labelId, confidence, status, source, evidence }, existing) {
    if (existing?.is_manual) return 'locked';
    const row = { confidence, status, source, evidence, updated_at: iso() };
    if (existing) {
      if (existing.status === status && existing.source === source && Math.abs(Number(existing.confidence) - confidence) < 0.001) return 'unchanged';
      const { data, error } = await supabase.from('music_track_labels').update(row)
        .eq('id', existing.id).eq('is_manual', false).select('id');
      check(error, 'update label');
      return data && data.length ? 'updated' : 'locked';
    }
    const { error } = await supabase.from('music_track_labels').insert({ music_id: musicId, label_id: labelId, is_manual: false, assigned_at: iso(), ...row });
    if (isDup(error)) return 'locked'; // somebody (maybe a human) inserted it first: theirs wins
    check(error, 'insert label');
    return 'inserted';
  }

  async function saveMetadata(musicId, fields) {
    const existing = await getMetadata(musicId);
    const row = { ...fields, updated_at: iso() };
    if (existing) {
      // Never blank out an id we already know just because this run's providers were down.
      for (const k of ['spotify_track_id', 'musicbrainz_recording_id', 'musicbrainz_work_id', 'isrc', 'detected_language', 'match_confidence']) {
        if (row[k] == null && existing[k] != null) delete row[k];
      }
      const { error } = await supabase.from('music_classification_metadata').update(row).eq('music_id', musicId);
      check(error, 'update classification metadata');
    } else {
      const { error } = await supabase.from('music_classification_metadata').insert({ music_id: musicId, ...row });
      if (isDup(error)) return saveMetadata(musicId, fields);
      check(error, 'insert classification metadata');
    }
  }

  async function saveSource(musicId, provider, { externalId, matchConfidence, scope, evidence }) {
    const row = { external_id: externalId || null, match_confidence: matchConfidence ?? null, scope: scope || null, evidence: evidence || {}, fetched_at: iso() };
    const { data } = await supabase.from('music_classification_sources').select('id').eq('music_id', musicId).eq('provider', provider).maybeSingle();
    const { error } = data
      ? await supabase.from('music_classification_sources').update(row).eq('id', data.id)
      : await supabase.from('music_classification_sources').insert({ music_id: musicId, provider, ...row });
    if (error && !isDup(error)) check(error, 'save source');
  }

  /** Fills the legacy columns ONLY when both are empty; returns true if it wrote. */
  async function syncLegacyLabel(musicId, legacyName) {
    if (!legacyName) return false;
    const { data: cl } = await supabase.from('content_labels').select('id, name, applies_to, is_active').eq('name', legacyName).eq('is_active', true);
    const label = (cl || []).find((l) => l.applies_to === 'music' || l.applies_to === 'both');
    if (!label) return false;
    const { data, error } = await supabase.from('media_items')
      .update({ content_label_id: label.id, category: label.name })
      .eq('id', musicId).is('content_label_id', null).is('category', null).select('id');
    check(error, 'sync legacy label');
    return Boolean(data && data.length);
  }

  /* ---------------------------------------------------- manual overrides */

  async function setManualLabel(musicId, labelKey, action, { actor = null, note = null } = {}) {
    const idx = await loadLabels();
    const label = idx.byKey.get(labelKey);
    if (!label) throw Object.assign(new Error(`unknown label ${labelKey}`), { status: 400 });
    const { data: existing } = await supabase.from('music_track_labels').select('*').eq('music_id', musicId).eq('label_id', label.id).maybeSingle();
    const status = { add: 'approved', approve: 'approved', remove: 'rejected', reject: 'rejected' }[action];
    if (!status) throw Object.assign(new Error(`unknown action ${action}`), { status: 400 });
    const evidence = { manual: true, action, actor, note, at: iso(), previous: existing ? { status: existing.status, confidence: existing.confidence, source: existing.source } : null };
    if (existing) {
      const { error } = await supabase.from('music_track_labels').update({ status, is_manual: true, source: MANUAL_SOURCE, confidence: action === 'add' ? 1 : existing.confidence, evidence, updated_at: iso() }).eq('id', existing.id);
      check(error, 'manual label update');
    } else {
      if (status === 'rejected' && action === 'reject') throw Object.assign(new Error('label is not assigned to this track'), { status: 404 });
      const { error } = await supabase.from('music_track_labels').insert({ music_id: musicId, label_id: label.id, confidence: status === 'approved' ? 1 : 0, source: MANUAL_SOURCE, status, is_manual: true, evidence, assigned_at: iso(), updated_at: iso() });
      check(error, 'manual label insert');
    }
    return { key: labelKey, status };
  }


  /**
   * "Change label": the only edit an admin makes to an automatic label. Swaps one label of a
   * track for another label of the SAME dimension, both from the fixed vocabulary (nothing is
   * ever created here). The new label is written first, so a failure half-way leaves the track
   * with an extra label rather than none. Both rows become manual, so the engine never reverts them.
   */
  async function changeManualLabel(musicId, fromKey, toKey, { actor = null, note = null } = {}) {
    const idx = await loadLabels();
    const from = idx.byKey.get(fromKey); const to = idx.byKey.get(toKey);
    if (!from || !to) throw Object.assign(new Error('unknown label'), { status: 400 });
    if (from.id === to.id) throw Object.assign(new Error('choose a different label'), { status: 400 });
    if (from.dimension !== to.dimension) throw Object.assign(new Error('a label can only be changed to another label of the same kind'), { status: 400 });
    const { data: existing } = await supabase.from('music_track_labels').select('*').eq('music_id', musicId).eq('label_id', from.id).maybeSingle();
    if (!existing || existing.status === 'rejected') throw Object.assign(new Error('the label being changed is not assigned to this track'), { status: 404 });
    const why = note || `changed from ${from.name} to ${to.name}`;
    await setManualLabel(musicId, toKey, 'add', { actor, note: why });
    await setManualLabel(musicId, fromKey, 'remove', { actor, note: why });
    return { from: fromKey, to: toKey, dimension: to.dimension };
  }

  /**
   * An admin's explicit genre choice also moves the legacy category the listener app browses by,
   * but only when that genre maps to an active music content label. (The automatic engine never
   * does this: it only ever fills an EMPTY legacy label.) Returns true if it wrote.
   */
  async function setLegacyLabelFromAdmin(musicId, legacyName) {
    if (!legacyName) return false;
    const { data: cl } = await supabase.from('content_labels').select('id, name, applies_to, is_active').eq('name', legacyName).eq('is_active', true);
    const label = (cl || []).find((l) => l.applies_to === 'music' || l.applies_to === 'both');
    if (!label) return false;
    const { data, error } = await supabase.from('media_items').update({ content_label_id: label.id, category: label.name }).eq('id', musicId).select('id');
    check(error, 'set legacy label');
    return Boolean(data && data.length);
  }

  /* ------------------------------------------------------ admin library */

  /** One page of music tracks plus the labels on each (admin screen). Titles/artists only: no covers, no audio. */
  async function loadLibraryPage({ limit = 30, offset = 0, onlyIds = null } = {}) {
    let q = supabase.from('media_items').select('id, title, artist_or_narrator, album_or_series, category, created_at').eq('type', 'music');
    if (onlyIds) { if (!onlyIds.length) return []; q = q.in('id', onlyIds); }
    const { data: tracks, error } = await q.order('created_at', { ascending: false }).range(offset, offset + limit - 1);
    check(error, 'load library');
    const ids = (tracks || []).map((t) => t.id);
    if (!ids.length) return [];
    const idx = await loadLabels();
    const [{ data: labels, error: e2 }, { data: metas, error: e3 }] = await Promise.all([
      supabase.from('music_track_labels').select('*').in('music_id', ids),
      supabase.from('music_classification_metadata').select('music_id, overall_status').in('music_id', ids)
    ]);
    check(e2, 'load library labels'); check(e3, 'load library metadata');
    const status = new Map((metas || []).map((m) => [m.music_id, m.overall_status]));
    return tracks.map((t) => ({
      id: t.id, title: t.title, artist: t.artist_or_narrator, album: t.album_or_series, legacyCategory: t.category,
      overallStatus: status.get(t.id) || 'unclassified',
      labels: (labels || []).filter((r) => r.music_id === t.id && r.status !== 'rejected')
        .map((r) => ({ ...r, label: idx.byId.get(r.label_id) })).filter((r) => r.label)
        .map((r) => ({ labelId: r.label_id, name: r.label.name, dimension: r.label.dimension, confidence: Number(r.confidence), status: r.status, manual: r.is_manual === true, source: r.source }))
    }));
  }

  /** Distinct track ids that have an automatic label still waiting for a human (provisional / needs_review). */
  async function loadAttentionIds({ limit = 30, offset = 0 } = {}) {
    const { data, error } = await supabase.from('music_track_labels').select('music_id, updated_at').in('status', ['provisional', 'needs_review']).eq('is_manual', false).order('updated_at', { ascending: false }).range(0, 4999);
    check(error, 'load attention ids');
    const seen = []; const set = new Set();
    for (const r of data || []) if (!set.has(r.music_id)) { set.add(r.music_id); seen.push(r.music_id); }
    return { ids: seen.slice(offset, offset + limit), total: seen.length };
  }

  return { changeManualLabel, setLegacyLabelFromAdmin, loadLibraryPage, loadAttentionIds, loadLabels, ensureTaxonomy, loadTrack, loadLyrics, loadTrackLabels, getMetadata, loadSources, writeAutoLabel, saveMetadata, saveSource, syncLegacyLabel, setManualLabel, MANUAL_SOURCE };
}

module.exports = { createStore, MANUAL_SOURCE };
