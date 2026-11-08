'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { seededService, addTrack, stubProvider } = require('./harness');
const { createWorker } = require('../../lib/classification/worker');

const ok = (observations = []) => stubProvider('musicbrainz', async () => ({ observations, meta: {}, source: null }));
const jobsOf = (db, id) => db.music_classification_jobs.filter((j) => j.music_id === id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('enqueue is idempotent: one open job per track, a new one is allowed once it is finished', async () => {
  const { svc, db } = await seededService();
  const t = addTrack(db, { title: 'A', artist_or_narrator: 'B' });
  assert.equal((await svc.queue.enqueue(t.id)).created, true);
  assert.equal((await svc.queue.enqueue(t.id)).created, false);
  assert.equal((await svc.queue.enqueue(t.id, { reason: 'manual' })).created, false);
  assert.equal(jobsOf(db, t.id).length, 1);
  await svc.worker.runUntilIdle({ deadlineMs: 2000 });
  assert.notEqual(jobsOf(db, t.id)[0].status, 'pending');
  assert.equal((await svc.queue.enqueue(t.id, { reason: 'reclassify' })).created, true);
});

test('concurrent enqueues of the same track produce exactly one job', async () => {
  const { svc, db } = await seededService();
  const t = addTrack(db, { title: 'A', artist_or_narrator: 'B' });
  const rs = await Promise.all(Array.from({ length: 20 }, () => svc.queue.enqueue(t.id)));
  assert.equal(rs.filter((r) => r.created).length, 1);
  assert.equal(jobsOf(db, t.id).length, 1);
});

test('worker runs a job: status reflects completeness (partially_completed is not "completed")', async () => {
  const { svc, db } = await seededService({ providers: [ok([{ key: 'genre:jazz', group: 'musicbrainz', p: 0.99, scope: 'recording', note: 'x' }])] });
  const t = addTrack(db, { title: 'Song', artist_or_narrator: 'X' });
  await svc.queue.enqueue(t.id);
  await svc.worker.runUntilIdle({ deadlineMs: 2000 });
  const j = jobsOf(db, t.id)[0];
  assert.equal(j.status, 'partially_completed', 'genre approved but language/vocal still unknown');
  assert.equal(j.locked_by, null); assert.ok(j.completed_at); assert.equal(j.result.outcome, 'partially_completed');
  assert.equal((await svc.store.getMetadata(t.id)).overall_status, 'partial');
});

test('a fully classified track completes', async () => {
  const obs = (key, g, p) => ({ key, group: g, p, scope: 'recording', note: key });
  const { svc, db } = await seededService({ providers: [ok([obs('genre:jazz', 'musicbrainz', 0.99), obs('language:english', 'musicbrainz', 0.99), obs('vocal:male-vocal', 'musicbrainz', 0.99), obs('version:original', 'musicbrainz', 0.99)])] });
  const t = addTrack(db, { title: 'Song', artist_or_narrator: 'X' });
  await svc.queue.enqueue(t.id);
  await svc.worker.runUntilIdle({ deadlineMs: 2000 });
  assert.equal(jobsOf(db, t.id)[0].status, 'completed');
  assert.equal((await svc.store.getMetadata(t.id)).overall_status, 'complete');
});

test('provider outage: job is re-queued with exponential backoff, then finishes as partial after max attempts', async () => {
  const down = stubProvider('musicbrainz', async () => { const { ProviderError } = require('../../lib/classification/providers/base'); throw new ProviderError('musicbrainz', 'unavailable', 'down'); });
  const { svc, db } = await seededService({ providers: [down], env: { CLASSIFICATION_MAX_ATTEMPTS: '3', CLASSIFICATION_BACKOFF_BASE_MS: '1000', CLASSIFICATION_BACKOFF_MAX_MS: '100000' } });
  const t = addTrack(db, { title: 'Song', artist_or_narrator: 'X' });
  await svc.queue.enqueue(t.id);
  const delays = [];
  for (let i = 1; i <= 3; i++) {
    await svc.worker.runUntilIdle({ deadlineMs: 1000 });
    const j = jobsOf(db, t.id)[0];
    assert.equal(j.attempts, i);
    if (i < 3) {
      assert.equal(j.status, 'pending'); assert.match(j.error_message, /will retry/);
      delays.push(new Date(j.next_retry_at).getTime() - Date.now());
      j.next_retry_at = new Date(Date.now() - 1).toISOString(); // fast-forward the clock
    }
  }
  assert.ok(delays[1] > delays[0] * 1.3, `backoff grows: ${delays}`);
  const j = jobsOf(db, t.id)[0];
  assert.equal(j.status, 'needs_review', 'final attempt keeps whatever was learned from the title instead of failing the track');
  assert.equal(j.dead_lettered_at, undefined);
});

test('nothing learnable + every provider failing => failed, dead-lettered after max attempts; retry-failed re-queues it', async () => {
  const down = stubProvider('musicbrainz', async () => { const { ProviderError } = require('../../lib/classification/providers/base'); throw new ProviderError('musicbrainz', 'unavailable', 'down'); });
  const { svc, db } = await seededService({ providers: [down], env: { CLASSIFICATION_MAX_ATTEMPTS: '2', CLASSIFY_REQUIRED_DIMENSIONS: 'genre' } });
  const t = addTrack(db, { title: 'Song', artist_or_narrator: 'X' });
  await svc.queue.enqueue(t.id);
  await svc.worker.runUntilIdle({ deadlineMs: 1000 });
  jobsOf(db, t.id)[0].next_retry_at = new Date(Date.now() - 1).toISOString();
  await svc.worker.runUntilIdle({ deadlineMs: 1000 });
  const j = jobsOf(db, t.id)[0];
  assert.equal(j.status, 'failed'); assert.ok(j.dead_lettered_at); assert.match(j.error_message, /providers failed/);
  assert.equal((await svc.store.getMetadata(t.id)).overall_status, 'failed');

  const r = await svc.queue.retryFailed();
  assert.equal(r.requeued, 1);
  assert.equal(jobsOf(db, t.id).filter((x) => x.status === 'pending').length, 1);
  assert.equal(jobsOf(db, t.id).filter((x) => x.status === 'failed').length, 0);
});

test('infrastructure errors (database/engine exceptions) retry, then dead-letter with the message', async () => {
  const { svc, db } = await seededService({ env: { CLASSIFICATION_MAX_ATTEMPTS: '2' } });
  const t = addTrack(db, { title: 'Song', artist_or_narrator: 'X' });
  svc.engine.classifyTrack = async () => { throw new Error('connection reset'); };
  const worker = createWorker({ queue: svc.queue, engine: svc.engine, config: svc.config, log() {} });
  await svc.queue.enqueue(t.id);
  await worker.runUntilIdle({ deadlineMs: 1000 });
  assert.equal(jobsOf(db, t.id)[0].status, 'pending');
  jobsOf(db, t.id)[0].next_retry_at = new Date(Date.now() - 1).toISOString();
  await worker.runUntilIdle({ deadlineMs: 1000 });
  const j = jobsOf(db, t.id)[0];
  assert.equal(j.status, 'failed'); assert.match(j.error_message, /connection reset/);
});

test('job timeout: a hung provider cannot block the worker forever', async () => {
  const hang = stubProvider('musicbrainz', () => new Promise(() => {}));
  const { svc, db } = await seededService({ providers: [hang], env: { CLASSIFICATION_JOB_TIMEOUT_MS: '60', CLASSIFY_PROVIDER_TIMEOUT_MS: '10000' } });
  const t = addTrack(db, { title: 'Song', artist_or_narrator: 'X' });
  await svc.queue.enqueue(t.id);
  const t0 = Date.now();
  await svc.worker.runUntilIdle({ deadlineMs: 2000 });
  assert.ok(Date.now() - t0 < 1500);
  assert.match(jobsOf(db, t.id)[0].error_message, /timed out/);
  assert.equal(jobsOf(db, t.id)[0].status, 'pending');
});

test('crash recovery: a job left "processing" by a dead worker is recovered and finished', async () => {
  const { svc, db } = await seededService();
  const t = addTrack(db, { title: 'Song', artist_or_narrator: 'X' });
  await svc.queue.enqueue(t.id);
  const [claimed] = await svc.queue.claim(1, 'dead-worker');
  assert.equal(claimed.status, 'processing');
  // not stale yet: nothing happens
  assert.equal(await svc.queue.recoverStale(), 0);
  db.music_classification_jobs[0].locked_at = new Date(Date.now() - 3600 * 1000).toISOString();
  assert.equal(await svc.queue.recoverStale(), 1);
  await svc.worker.runUntilIdle({ deadlineMs: 1000 });
  assert.notEqual(jobsOf(db, t.id)[0].status, 'pending');
  assert.equal(jobsOf(db, t.id)[0].locked_by, null);
});

test('a track deleted before its job runs is cancelled', async () => {
  const { svc, db } = await seededService();
  const t = addTrack(db, { title: 'Song', artist_or_narrator: 'X' });
  await svc.queue.enqueue(t.id);
  db.media_items.length = 0;
  await svc.worker.runUntilIdle({ deadlineMs: 1000 });
  assert.equal(jobsOf(db, t.id)[0].status, 'cancelled');
});

test('concurrency limit is respected', async () => {
  let running = 0; let peak = 0;
  const slow = stubProvider('musicbrainz', async () => { running++; peak = Math.max(peak, running); await sleep(30); running--; return { observations: [], meta: {}, source: null }; });
  const { svc, db } = await seededService({ providers: [slow], env: { CLASSIFICATION_CONCURRENCY: '2' } });
  for (let i = 0; i < 7; i++) { const t = addTrack(db, { title: `S${i}`, artist_or_narrator: 'X' }); await svc.queue.enqueue(t.id); }
  await svc.worker.runUntilIdle({ deadlineMs: 5000 });
  assert.equal(peak, 2);
  assert.equal(db.music_classification_jobs.filter((j) => j.status !== 'pending').length, 7);
});

test('uploads outrank backfill jobs', async () => {
  const { svc, db } = await seededService();
  const bf = addTrack(db, { title: 'Old', artist_or_narrator: 'X' }); const up = addTrack(db, { title: 'New', artist_or_narrator: 'X' });
  await svc.queue.enqueue(bf.id, { reason: 'backfill' }); await svc.queue.enqueue(up.id, { reason: 'upload' });
  const [first] = await svc.queue.claim(1, 'w');
  assert.equal(first.music_id, up.id);
});

test('graceful shutdown: running jobs finish within the grace period, otherwise they are handed back untouched', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = stubProvider('musicbrainz', async () => { await gate; return { observations: [], meta: {}, source: null }; });
  const { svc, db } = await seededService({ providers: [slow], env: { CLASSIFICATION_SHUTDOWN_GRACE_MS: '50' } });
  const t = addTrack(db, { title: 'Song', artist_or_narrator: 'X' });
  await svc.queue.enqueue(t.id);
  await svc.worker.pollOnce();
  assert.equal(svc.worker.activeCount, 1);
  const r = await svc.worker.stop();
  assert.equal(r.released, 1);
  const j = jobsOf(db, t.id)[0];
  assert.equal(j.status, 'pending'); assert.equal(j.attempts, 0); assert.equal(j.locked_by, null);
  release();
  await sleep(10);
  // a fresh worker picks the released job up again
  await svc.worker.runUntilIdle({ deadlineMs: 1000 });
  assert.notEqual(jobsOf(db, t.id)[0].status, 'pending');
});

test('the long-running loop drains the queue by itself and stops cleanly', async () => {
  const { svc, db } = await seededService({ env: { CLASSIFICATION_POLL_MS: '20' } });
  const ids = [];
  for (let i = 0; i < 4; i++) { const t = addTrack(db, { title: `S${i}`, artist_or_narrator: 'X' }); ids.push(t.id); await svc.queue.enqueue(t.id); }
  svc.worker.start();
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && db.music_classification_jobs.some((j) => j.status === 'pending' || j.status === 'processing')) await sleep(20);
  await svc.worker.stop();
  assert.ok(db.music_classification_jobs.every((j) => !['pending', 'processing'].includes(j.status)));
  assert.equal(svc.worker.running, false);
});

test('manual reclassification of selected tracks uses the same queue and engine', async () => {
  const { svc, db } = await seededService();
  const a = addTrack(db, { title: 'A', artist_or_narrator: 'X' }); const b = addTrack(db, { title: 'B', artist_or_narrator: 'X' });
  const r = await svc.reclassify({ ids: [a.id, b.id, a.id] });
  assert.deepEqual([r.created, r.alreadyQueued], [2, 0]);
  assert.equal((await svc.reclassify({ ids: [a.id] })).alreadyQueued, 1);
  assert.ok(db.music_classification_jobs.every((j) => j.reason === 'reclassify'));
});
