'use strict';

/**
 * Wires the engine, queue, worker and backfill together and exposes the operations
 * the routes, the CLI and routes/media.js use. `createService(deps)` is fully
 * injectable (tests); `getService()` builds the production singleton lazily so
 * requiring this file never opens a database connection by itself.
 */
const { load: loadConfig, summary: configSummary } = require('./config');
const taxonomy = require('./taxonomy');
const { createCache } = require('./cache');
const { createStats } = require('./stats');
const { createBreaker, ProviderError } = require('./providers/base');
const { buildProviders } = require('./providers');
const { createStore } = require('./store');
const { createQueue } = require('./queue');
const { createEngine } = require('./engine');
const { createBackfill } = require('./backfill');
const { createWorker } = require('./worker');

const MAX_BATCH_IDS = 1000;

const LEVELS = { info: 0, warn: 1, error: 2, silent: 3 };
const logger = (level, event, fields = {}) => {
  if ((LEVELS[level] ?? 0) < (LEVELS[String(process.env.CLASSIFICATION_LOG_LEVEL || 'info').toLowerCase()] ?? 0)) return;
  // Structured, one JSON object per line. Never includes credentials: only ids and short messages.
  const line = JSON.stringify({ t: new Date().toISOString(), level, component: 'classification', event, ...fields });
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
};

function createService({ supabase, config = loadConfig(), http, llmClassify, audioLink, invalidateMediaItem, providers = buildProviders(), log = logger }) {
  const stats = createStats({ supabase });
  const cache = createCache({ supabase, config });
  const breaker = createBreaker({ failures: config.providers.breakerFailures, cooldownMs: config.providers.breakerCooldownMs });
  const store = createStore(supabase);
  const queue = createQueue({ supabase, config });
  const engine = createEngine({ store, config, providers, http, cache, stats, breaker, llmClassify, audioLink, invalidateMediaItem, log });
  const backfill = createBackfill({ supabase, queue, config, log });
  const worker = createWorker({ queue, engine, backfill, config, log });

  /**
   * Called by routes/media.js AFTER a music row was inserted. Never throws and never
   * waits on any provider: at worst the job is not created and the backfill picks the
   * track up later (it has no classification metadata, so it is a candidate).
   */
  async function enqueueForUpload(musicId) {
    try { return await queue.enqueue(musicId, { reason: 'upload' }); }
    catch (e) { log('error', 'enqueue_failed', { trackId: musicId, message: e.message }); return { created: false, error: e.message }; }
  }

  async function reclassify({ ids, all = false, dimensions = null, limit }) {
    if (all) return { backfill: await backfill.start({ reclassifyAll: true, limit }) };
    const list = [...new Set(ids || [])].slice(0, MAX_BATCH_IDS);
    if (!list.length) throw Object.assign(new Error('ids[] or all=true is required'), { status: 400 });
    let created = 0; let alreadyQueued = 0;
    for (const id of list) { const r = await queue.enqueue(id, { reason: 'reclassify', dimensions }); r.created ? created++ : alreadyQueued++; }
    return { created, alreadyQueued };
  }

  async function status() {
    const { data, error } = await supabase.rpc('classification_stats');
    if (error) throw new Error(`classification_stats: ${error.message}`);
    const s = data || {};
    const jobs = s.jobs || {};
    const classified = (s.complete || 0) + (s.partial || 0) + (s.needs_review || 0) + (s.failed || 0);
    return {
      tracks: { total: s.total_tracks || 0, fullyClassified: s.complete || 0, partiallyClassified: s.partial || 0, needsReview: s.needs_review || 0, failed: s.failed || 0, unclassified: Math.max(0, (s.total_tracks || 0) - classified) },
      jobs: { pending: jobs.pending || 0, processing: jobs.processing || 0, completed: jobs.completed || 0, partiallyCompleted: jobs.partially_completed || 0, needsReview: jobs.needs_review || 0, failed: jobs.failed || 0, cancelled: jobs.cancelled || 0 },
      avgClassificationSeconds: s.avg_classification_seconds ?? null,
      oldestPendingSeconds: s.oldest_pending_seconds ?? null,
      providers: { ...(s.providers || {}), _thisProcess: stats.snapshot() },
      backfill: await backfill.status(),
      worker: { running: worker.running, active: worker.activeCount, ...worker.counters },
      config: configSummary(config)
    };
  }

  async function trackDetail(id) {
    const track = await store.loadTrack(id);
    if (!track) throw Object.assign(new Error('track not found'), { status: 404 });
    const [labels, metadata, sources] = await Promise.all([store.loadTrackLabels(id), store.getMetadata(id), store.loadSources(id)]);
    const { data: jobs } = await supabase.from('music_classification_jobs').select('id,status,reason,attempts,error_message,created_at,completed_at,next_retry_at').eq('music_id', id).order('created_at', { ascending: false }).limit(10);
    return {
      track: { id: track.id, title: track.title, artist: track.artist_or_narrator, album: track.albumName, legacyCategory: track.category },
      metadata, sources, jobs: jobs || [],
      labels: labels.map((r) => ({
        labelId: r.label_id, key: r.label.key, name: r.label.name, dimension: r.label.dimension,
        path: [...taxonomy.ancestorsOf(r.label.key).reverse().map((k) => taxonomy.get(k).name), r.label.name],
        confidence: Number(r.confidence), source: r.source, status: r.status, manual: r.is_manual, evidence: r.evidence, updatedAt: r.updated_at
      }))
    };
  }

  /** Approved labels only, grouped by dimension (safe for listeners). */
  async function publicLabels(id) {
    const labels = (await store.loadTrackLabels(id)).filter((r) => r.status === 'approved');
    const out = {};
    for (const r of labels) (out[r.label.dimension] ||= []).push({ name: r.label.name, slug: r.label.slug, confidence: Number(r.confidence) });
    return out;
  }

  async function reviewQueue({ limit = 50, offset = 0, dimension } = {}) {
    const idx = await store.loadLabels();
    const { data, error } = await supabase.from('music_track_labels').select('*').in('status', ['provisional', 'needs_review']).eq('is_manual', false)
      .order('updated_at', { ascending: false }).range(offset, offset + Math.min(200, limit) - 1);
    if (error) throw new Error(error.message);
    return (data || []).map((r) => ({ ...r, label: idx.byId.get(r.label_id) })).filter((r) => r.label && (!dimension || r.label.dimension === dimension))
      .map((r) => ({ musicId: r.music_id, labelId: r.label_id, name: r.label.name, dimension: r.label.dimension, confidence: Number(r.confidence), status: r.status, source: r.source, updatedAt: r.updated_at }));
  }

  async function manualLabel(musicId, { labelId, key, action, actor, note }) {
    const idx = await store.loadLabels();
    const labelKey = key || idx.byId.get(labelId)?.key;
    if (!labelKey) throw Object.assign(new Error('labelId or key is required'), { status: 400 });
    if (!(await store.loadTrack(musicId))) throw Object.assign(new Error('track not found'), { status: 404 });
    const r = await store.setManualLabel(musicId, labelKey, action, { actor, note });
    return r;
  }

  /** Admin changes one label to another of the same kind (fixed vocabulary only). */
  async function changeLabel(musicId, { fromLabelId, toLabelId, actor, note }) {
    const idx = await store.loadLabels();
    const fromKey = idx.byId.get(fromLabelId)?.key; const toKey = idx.byId.get(toLabelId)?.key;
    if (!fromKey || !toKey) throw Object.assign(new Error('fromLabelId and toLabelId must be labels from the list'), { status: 400 });
    if (!(await store.loadTrack(musicId))) throw Object.assign(new Error('track not found'), { status: 404 });
    const r = await store.changeManualLabel(musicId, fromKey, toKey, { actor, note });
    // A new genre also moves the category the listener app browses by (only if that genre maps to one).
    if (r.dimension === 'genre') {
      try { if (await store.setLegacyLabelFromAdmin(musicId, taxonomy.legacyNameForKey(toKey))) invalidateMediaItem?.(musicId); }
      catch (e) { log('warn', 'legacy_sync_failed', { trackId: musicId, message: e.message }); }
    }
    return r;
  }

  /** Music tracks with their labels, for the admin screen. attention = only tracks with labels awaiting a human. */
  async function library({ limit = 30, offset = 0, attention = false, labelId = null } = {}) {
    if (attention) {
      const { ids, total } = await store.loadAttentionIds({ limit, offset });
      return { total, items: await store.loadLibraryPage({ limit, offset: 0, onlyIds: ids }) };
    }
    if (labelId) {
      const { data, error } = await supabase.from('music_track_labels').select('music_id').eq('label_id', labelId).eq('status', 'approved').range(offset, offset + limit - 1);
      if (error) throw new Error(error.message);
      return { total: null, items: await store.loadLibraryPage({ limit, offset: 0, onlyIds: (data || []).map((r) => r.music_id) }) };
    }
    return { total: null, items: await store.loadLibraryPage({ limit, offset }) };
  }

  function startWorker() { if (config.worker.enabled) { store.ensureTaxonomy().catch((e) => log('error', 'seed_failed', { message: e.message })); worker.start(); } }

  return { config, store, queue, engine, backfill, worker, stats, enqueueForUpload, reclassify, status, trackDetail, publicLabels, reviewQueue, manualLabel, changeLabel, library, startWorker, stopWorker: () => worker.stop(), log };
}

/**
 * Audio analysis (optional, off by default) must NEVER pull audio through the Render backend: that is
 * the bandwidth this project is built to avoid. The link points at the Cloudflare audio worker (which
 * streams straight from Drime) and is refused outright when that worker is not configured.
 */
function makeAudioLink(env = process.env) {
  return async function audioLink(mediaItemId, ttlSeconds) {
    const { signMediaToken } = require('../../middleware/auth');
    const base = String(env.AUDIO_CDN_BASE_URL || '').replace(/\/$/, '');
    if (!base) throw new ProviderError('audio', 'auth', 'AUDIO_CDN_BASE_URL is not set: refusing to send audio through the Render backend', { retryable: false });
    return `${base}/api/storage/stream/${mediaItemId}?token=${encodeURIComponent(signMediaToken(mediaItemId, 'stream', ttlSeconds))}`;
  };
}

/* ------------------------------------------------- production singleton */
let singleton = null;
function getService() {
  if (singleton) return singleton;
  const axios = require('axios');
  const supabase = require('../supabaseClient');
  const config = loadConfig();

  async function llmClassify(args) {
    const groq = require('../groq');
    const groqAccountCache = require('../groqAccountCache');
    const { decrypt } = require('../crypto');
    let last;
    for (let attempt = 0; attempt < 2; attempt++) {
      let account; let apiKey;
      try {
        account = await groqAccountCache.pick();
        if (!account) throw new Error('no account');
        apiKey = JSON.parse(decrypt(account.credentials_enc)).apiKey;
        if (!apiKey) throw new Error('no key');
      } catch (e) {
        // Not configured (or unreadable credentials): retrying cannot help, so say so once and let the breaker rest.
        throw new ProviderError('llm', 'auth', 'no usable Groq account configured', { retryable: false });
      }
      try { return await groq.classifyTrack({ ...args, apiKey }); }
      catch (e) {
        last = e;
        if (e.response?.status === 429) { groqAccountCache.markRateLimited(account.id, groq.parseRetryAfterMs(groq.extractErrorMessage(e))); continue; }
        throw e;
      }
    }
    throw last;
  }

  singleton = createService({
    supabase, config, http: axios, llmClassify, audioLink: makeAudioLink(),
    invalidateMediaItem: (id) => { try { require('../mediaItemCache').invalidate(id); } catch (_) { /* cache is optional */ } }
  });
  return singleton;
}

module.exports = { createService, getService, makeAudioLink };
