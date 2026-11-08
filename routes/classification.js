'use strict';

/**
 * Admin API for the music classification system. Mounted at /api/classification.
 *   GET    /status                       dashboard numbers (tracks, jobs, providers, backfill, worker)
 *   GET    /labels[?dimension=]          controlled vocabulary (any logged-in user)
 *   GET    /review[?dimension=&limit=]   provisional / needs_review labels waiting for a human
 *   GET    /tracks/:id                   full classification detail + evidence
 *   GET    /tracks/:id/labels            approved labels only (any logged-in user)
 *   POST   /tracks/:id/labels            { labelId|key, action: add|remove|approve|reject, note? }  manual override
 *   POST   /tracks/:id/reclassify
 *   POST   /reclassify                   { ids: [...] } | { all: true }
 *   POST   /backfill                     { batchSize?, dryRun?, minVersion?, requiredDimensions?, limit? }
 *   GET    /backfill                     current / latest backfill
 *   POST   /backfill/pause | /resume | /cancel
 *   GET    /jobs[?status=&limit=]        recent jobs
 *   POST   /jobs/retry-failed
 *   POST   /seed                         (re)seed the label vocabulary
 *   POST   /cron/run                     x-cron-secret: drain the queue for a bounded time (for external schedulers)
 */
const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { DIMENSIONS } = require('../lib/classification/taxonomy');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JOB_STATUSES = ['pending', 'processing', 'completed', 'partially_completed', 'failed', 'needs_review', 'cancelled'];

function createRouter({ getService, supabase }) {
  const router = express.Router();
  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (e) { res.status(e.status || 500).json({ error: e.message || 'Classification request failed' }); }
  };
  const svc = () => getService();
  const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
  const needId = (id) => { if (!UUID.test(String(id))) throw bad('invalid track id'); return id; };
  const intIn = (v, d, max) => Math.min(max, Math.max(1, Number.isFinite(Number(v)) ? Math.floor(Number(v)) : d));

  router.get('/labels', requireAuth, wrap(async (req, res) => {
    const { dimension } = req.query;
    if (dimension && !DIMENSIONS.includes(dimension)) throw bad(`dimension must be one of ${DIMENSIONS.join(', ')}`);
    const idx = await svc().store.loadLabels();
    const labels = [...idx.byId.values()].filter((l) => l.is_active !== false && (!dimension || l.dimension === dimension))
      .map((l) => ({ id: l.id, name: l.name, slug: l.slug, dimension: l.dimension, parentId: l.parent_id }));
    res.json({ labels });
  }));

  router.get('/tracks/:id/labels', requireAuth, wrap(async (req, res) => {
    res.json({ labels: await svc().publicLabels(needId(req.params.id)) });
  }));

  // Everything below is admin-only.
  router.use(requireAuth, requireAdmin);

  router.get('/status', wrap(async (req, res) => res.json(await svc().status())));

  router.get('/review', wrap(async (req, res) => {
    const { dimension } = req.query;
    if (dimension && !DIMENSIONS.includes(dimension)) throw bad(`dimension must be one of ${DIMENSIONS.join(', ')}`);
    res.json({ items: await svc().reviewQueue({ limit: intIn(req.query.limit, 50, 200), offset: Math.max(0, Number(req.query.offset) || 0), dimension }) });
  }));

  router.get('/tracks/:id', wrap(async (req, res) => res.json(await svc().trackDetail(needId(req.params.id)))));

  router.post('/tracks/:id/labels', wrap(async (req, res) => {
    const { labelId, key, action, note } = req.body || {};
    if (!['add', 'remove', 'approve', 'reject'].includes(action)) throw bad('action must be add, remove, approve or reject');
    if (labelId && !UUID.test(String(labelId))) throw bad('invalid labelId');
    res.json(await svc().manualLabel(needId(req.params.id), { labelId, key, action, note: note ? String(note).slice(0, 500) : null, actor: req.user.sub }));
  }));

  router.post('/tracks/:id/reclassify', wrap(async (req, res) => {
    res.json(await svc().reclassify({ ids: [needId(req.params.id)], dimensions: validDims(req.body?.dimensions) }));
  }));

  function validDims(d) {
    if (d === undefined || d === null) return null;
    if (!Array.isArray(d) || d.some((x) => !DIMENSIONS.includes(x))) throw bad(`dimensions must be an array of: ${DIMENSIONS.join(', ')}`);
    return d;
  }

  router.post('/reclassify', wrap(async (req, res) => {
    const { ids, all, dimensions } = req.body || {};
    if (all === true) return res.json(await svc().reclassify({ all: true }));
    if (!Array.isArray(ids) || !ids.length || ids.some((i) => !UUID.test(String(i)))) throw bad('ids must be a non-empty array of track ids (or send {"all": true})');
    res.json(await svc().reclassify({ ids, dimensions: validDims(dimensions) }));
  }));

  router.get('/backfill', wrap(async (req, res) => res.json({ backfill: await svc().backfill.status() })));
  router.post('/backfill', wrap(async (req, res) => {
    const b = req.body || {};
    const requiredDimensions = b.requiredDimensions === undefined ? undefined : validDims(b.requiredDimensions);
    res.json({ backfill: await svc().backfill.start({ batchSize: b.batchSize, dryRun: b.dryRun === true, minVersion: b.minVersion, requiredDimensions, limit: b.limit }) });
  }));
  for (const action of ['pause', 'resume', 'cancel']) {
    router.post(`/backfill/${action}`, wrap(async (req, res) => res.json({ backfill: await svc().backfill[action]() })));
  }

  router.get('/jobs', wrap(async (req, res) => {
    const { status } = req.query;
    if (status && !JOB_STATUSES.includes(status)) throw bad(`status must be one of ${JOB_STATUSES.join(', ')}`);
    let q = supabase.from('music_classification_jobs').select('id,music_id,status,reason,attempts,max_attempts,error_message,created_at,started_at,completed_at,next_retry_at,dead_lettered_at')
      .order('created_at', { ascending: false }).limit(intIn(req.query.limit, 50, 200));
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    res.json({ jobs: data || [] });
  }));
  router.post('/jobs/retry-failed', wrap(async (req, res) => res.json(await svc().queue.retryFailed({ limit: intIn(req.body?.limit, 500, 5000) }))));

  router.post('/seed', wrap(async (req, res) => res.json({ inserted: await svc().store.ensureTaxonomy() })));

  return router;
}

// The cron endpoint authenticates with a shared secret instead of a JWT (like /api/subscriptions/cron/run),
// so it is exported separately and mounted BEFORE the device gate in server.js.
function createCronRouter({ getService }) {
  const router = express.Router();
  router.post('/run', async (req, res) => {
    const secret = process.env.CLASSIFICATION_CRON_SECRET;
    if (!secret) return res.status(404).json({ error: 'Not found' });
    if (req.headers['x-cron-secret'] !== secret) return res.status(401).json({ error: 'Invalid cron secret' });
    try {
      const out = await getService().worker.runUntilIdle({ deadlineMs: Math.min(50000, Number(req.body?.deadlineMs) || 20000) });
      res.json({ ok: true, ...out });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  return router;
}

const getDefaultService = () => require('../lib/classification/service').getService();
const lazySupabase = new Proxy({}, { get: (_, k) => require('../lib/supabaseClient')[k] });

module.exports = createRouter({ getService: getDefaultService, supabase: lazySupabase });
module.exports.createRouter = createRouter;
module.exports.createCronRouter = createCronRouter;
module.exports.cron = createCronRouter({ getService: getDefaultService });
