'use strict';
process.env.JWT_SECRET = 'test-secret';
process.env.TOKEN_ENC_KEY = '0'.repeat(64);

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { seededService, addTrack, stubProvider } = require('./harness');
const { createRouter, createCronRouter } = require('../../routes/classification');

const admin = jwt.sign({ sub: 'admin-1', role: 'admin' }, 'test-secret');
const listener = jwt.sign({ sub: 'user-1', role: 'listener' }, 'test-secret');
const obs = (key, g, p) => ({ key, group: g, p, scope: 'recording', note: key });

let ctx; let server; let base; let trackId;
test.before(async () => {
  ctx = await seededService({ providers: [stubProvider('musicbrainz', async () => ({ observations: [obs('genre:jazz', 'musicbrainz', 0.99), obs('mood:calm', 'musicbrainz', 0.6), obs('mood:calm', 'lastfm', 0.5)], meta: {}, source: null }))] });
  trackId = addTrack(ctx.db, { title: 'Blue Train', artist_or_narrator: 'John Coltrane' }).id;
  const app = express(); app.use(express.json());
  app.use('/api/classification/cron', createCronRouter({ getService: () => ctx.svc }));
  app.use('/api/classification', createRouter({ getService: () => ctx.svc, supabase: ctx.fake }));
  server = http.createServer(app); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api/classification`;
});
test.after(() => server.close());

const call = async (method, path, { token = admin, body, headers } = {}) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test('authentication and authorisation', async () => {
  assert.equal((await call('GET', '/status', { token: null })).status, 401);
  assert.equal((await call('GET', '/status', { token: listener })).status, 403);
  assert.equal((await call('POST', '/backfill', { token: listener, body: {} })).status, 403);
  assert.equal((await call('GET', '/labels', { token: listener })).status, 200, 'vocabulary is readable by any signed-in user');
  assert.equal((await call('GET', '/labels', { token: null })).status, 401);
});

test('labels endpoint filters by dimension and validates it', async () => {
  const r = await call('GET', '/labels?dimension=version');
  assert.equal(r.status, 200); assert.ok(r.body.labels.length >= 19); assert.ok(r.body.labels.every((l) => l.dimension === 'version'));
  assert.equal((await call('GET', '/labels?dimension=nope')).status, 400);
});

test('classify via reclassify -> worker, then inspect evidence; listeners only see approved labels', async () => {
  const q = await call('POST', `/tracks/${trackId}/reclassify`, { body: {} });
  assert.equal(q.status, 200); assert.equal(q.body.created, 1);
  await ctx.svc.worker.runUntilIdle({ deadlineMs: 2000 });
  const d = await call('GET', `/tracks/${trackId}`);
  assert.equal(d.status, 200);
  const jazz = d.body.labels.find((l) => l.key === 'genre:jazz');
  assert.equal(jazz.status, 'approved'); assert.ok(jazz.confidence > 0.95); assert.ok(jazz.evidence.observations.length); assert.deepEqual(jazz.path, ['Jazz']);
  assert.ok(d.body.metadata && d.body.jobs.length);
  const calm = d.body.labels.find((l) => l.key === 'mood:calm');
  assert.equal(calm.status, 'provisional');
  const pub = await call('GET', `/tracks/${trackId}/labels`, { token: listener });
  assert.deepEqual(Object.keys(pub.body.labels).sort(), ['genre', 'version'].filter((k) => pub.body.labels[k]).sort());
  assert.ok(!JSON.stringify(pub.body).includes('provisional') && !JSON.stringify(pub.body).includes('evidence'));
  assert.ok(!pub.body.labels.mood, 'provisional labels are hidden from listeners');
});

test('review queue lists provisional / needs_review labels; a human can approve or reject them', async () => {
  const q = await call('GET', '/review?dimension=mood');
  const item = q.body.items.find((i) => i.name === 'Calm');
  assert.ok(item); assert.equal(item.status, 'provisional'); assert.equal(item.musicId, trackId);
  const ap = await call('POST', `/tracks/${trackId}/labels`, { body: { labelId: item.labelId, action: 'approve', note: 'sounds calm' } });
  assert.equal(ap.status, 200);
  const d = await call('GET', `/tracks/${trackId}`);
  const calm = d.body.labels.find((l) => l.key === 'mood:calm');
  assert.equal(calm.status, 'approved'); assert.equal(calm.manual, true); assert.equal(calm.evidence.actor, 'admin-1'); assert.equal(calm.evidence.note, 'sounds calm');
  assert.equal((await call('GET', '/review?dimension=mood')).body.items.find((i) => i.name === 'Calm'), undefined, 'handled items leave the queue');
});

test('manual add / remove, protected from reclassification', async () => {
  assert.equal((await call('POST', `/tracks/${trackId}/labels`, { body: { key: 'context:late-night', action: 'add' } })).status, 200);
  assert.equal((await call('POST', `/tracks/${trackId}/labels`, { body: { key: 'genre:jazz', action: 'remove' } })).status, 200);
  await call('POST', `/tracks/${trackId}/reclassify`, { body: {} });
  await ctx.svc.worker.runUntilIdle({ deadlineMs: 2000 });
  const d = await call('GET', `/tracks/${trackId}`);
  assert.equal(d.body.labels.find((l) => l.key === 'context:late-night').status, 'approved');
  assert.equal(d.body.labels.find((l) => l.key === 'genre:jazz').status, 'rejected');
  const pub = await call('GET', `/tracks/${trackId}/labels`, { token: listener });
  assert.ok(!pub.body.labels.genre, 'a removed label is not shown');
  assert.ok(pub.body.labels.context);
});

test('input validation', async () => {
  assert.equal((await call('GET', '/tracks/not-a-uuid')).status, 400);
  assert.equal((await call('POST', `/tracks/${trackId}/labels`, { body: { key: 'genre:jazz', action: 'delete-everything' } })).status, 400);
  assert.equal((await call('POST', `/tracks/${trackId}/labels`, { body: { key: 'genre:nonexistent', action: 'add' } })).status, 400);
  assert.equal((await call('POST', `/tracks/${trackId}/labels`, { body: { labelId: 'zzz', action: 'add' } })).status, 400);
  assert.equal((await call('POST', '/reclassify', { body: { ids: ['nope'] } })).status, 400);
  assert.equal((await call('POST', '/reclassify', { body: {} })).status, 400);
  assert.equal((await call('POST', '/backfill', { body: { requiredDimensions: ['bogus'] } })).status, 400);
  assert.equal((await call('GET', '/jobs?status=weird')).status, 400);
  assert.equal((await call('GET', '/tracks/00000000-0000-4000-8000-0000000000fe')).status, 404);
});

test('backfill lifecycle over the API: dry run, start, status, pause, resume, cancel, 409 on a second start', async () => {
  for (let i = 0; i < 5; i++) addTrack(ctx.db, { title: `Legacy ${i}`, artist_or_narrator: 'X', category: 'Folk' });
  const dry = await call('POST', '/backfill', { body: { dryRun: true, batchSize: 3 } });
  assert.equal(dry.status, 200); assert.equal(dry.body.backfill.dry_run, true);
  await ctx.svc.backfill.tick(); await ctx.svc.backfill.tick();
  let st = await call('GET', '/backfill');
  assert.ok(st.body.backfill.stats.would_enqueue >= 3);
  assert.equal((await call('POST', '/backfill', { body: {} })).status, 409);
  assert.equal((await call('POST', '/backfill/cancel')).status, 200);
  const jobsBefore = ctx.db.music_classification_jobs.length;
  assert.equal((await call('POST', '/backfill', { body: { batchSize: 2 } })).status, 200);
  assert.equal((await call('POST', '/backfill/pause')).body.backfill.status, 'paused');
  assert.equal((await call('POST', '/backfill/pause')).status, 409);
  assert.equal((await call('POST', '/backfill/resume')).body.backfill.status, 'running');
  st = await call('GET', '/status');
  assert.equal(st.status, 200); assert.ok(st.body.backfill);
  await call('POST', '/backfill/cancel');
  assert.equal((await call('POST', '/backfill/resume')).status, 404, 'nothing active to resume');
  assert.equal(ctx.db.music_classification_jobs.length, jobsBefore, 'dry run + control calls enqueued nothing');
});

test('status dashboard: counts, jobs, provider health, config without secrets', async () => {
  const s = (await call('GET', '/status')).body;
  assert.ok(s.tracks.total >= 6);
  for (const k of ['fullyClassified', 'partiallyClassified', 'unclassified', 'needsReview', 'failed']) assert.ok(k in s.tracks, k);
  for (const k of ['pending', 'processing', 'failed', 'completed']) assert.ok(k in s.jobs, k);
  assert.ok('avgClassificationSeconds' in s); assert.ok(s.worker && s.config.providers);
  assert.ok(!JSON.stringify(s).match(/secret|api[_-]?key|password/i), 'no credentials in the status payload');
});

test('jobs listing and retry-failed', async () => {
  ctx.db.music_classification_jobs.push({ id: 'j-x', music_id: trackId, status: 'failed', attempts: 5, max_attempts: 5, created_at: new Date().toISOString(), dead_lettered_at: new Date().toISOString(), error_message: 'x' });
  const l = await call('GET', '/jobs?status=failed');
  assert.equal(l.status, 200); assert.ok(l.body.jobs.every((j) => j.status === 'failed'));
  const r = await call('POST', '/jobs/retry-failed', { body: {} });
  assert.equal(r.status, 200); assert.equal(r.body.requeued, 1);
});

test('cron endpoint: hidden without a secret, 401 on a wrong one, drains the queue with the right one', async () => {
  delete process.env.CLASSIFICATION_CRON_SECRET;
  const raw = (headers) => fetch(`http://127.0.0.1:${server.address().port}/api/classification/cron/run`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });
  assert.equal((await raw({})).status, 404);
  process.env.CLASSIFICATION_CRON_SECRET = 's3cret';
  try {
    assert.equal((await raw({ 'x-cron-secret': 'wrong' })).status, 401);
    const t2 = addTrack(ctx.db, { title: 'Cron Song', artist_or_narrator: 'X' });
    await ctx.svc.queue.enqueue(t2.id);
    const ok = await raw({ 'x-cron-secret': 's3cret' });
    assert.equal(ok.status, 200);
    assert.notEqual(ctx.db.music_classification_jobs.find((j) => j.music_id === t2.id).status, 'pending');
  } finally { delete process.env.CLASSIFICATION_CRON_SECRET; }
});
