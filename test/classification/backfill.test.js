'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { seededService, addTrack, stubProvider } = require('./harness');
const { createService } = require('../../lib/classification/service');

const noop = stubProvider('musicbrainz', async () => ({ observations: [], meta: {}, source: null }));
const pending = (db) => db.music_classification_jobs.filter((j) => j.status === 'pending');
const labelId = (db, key) => { const [d, s] = key.split(':'); return db.music_labels.find((l) => l.dimension === d && l.slug === s).id; };

test('historical tracks are discovered: null labels, legacy labels, partial classification; non-music and complete ones are not', async () => {
  const { svc, db } = await seededService({ providers: [noop] });
  const nullLabel = addTrack(db, { title: 'A', artist_or_narrator: 'X' });
  const legacy = addTrack(db, { title: 'B', artist_or_narrator: 'X', category: 'Bollywood', content_label_id: 'cl-1' });
  const partial = addTrack(db, { title: 'C', artist_or_narrator: 'X' });
  db.music_classification_metadata.push({ music_id: partial.id, classification_version: 1, overall_status: 'partial', dimension_status: { genre: 'approved' } });
  db.music_track_labels.push({ id: 'r1', music_id: partial.id, label_id: labelId(db, 'genre:jazz'), status: 'approved', confidence: 0.99 });
  const complete = addTrack(db, { title: 'D', artist_or_narrator: 'X' });
  db.music_classification_metadata.push({ music_id: complete.id, classification_version: 1, overall_status: 'complete', dimension_status: { genre: 'approved', language: 'approved', vocal: 'approved', version: 'approved' } });
  const story = addTrack(db, { type: 'audio_story', title: 'Katha' });

  await svc.backfill.start({ batchSize: 50 });
  while (!(await svc.backfill.tick()).done) { /* drain */ }
  const queued = new Set(db.music_classification_jobs.map((j) => j.music_id));
  assert.ok(queued.has(nullLabel.id)); assert.ok(queued.has(legacy.id), 'a legacy label does not exempt a track from classification');
  assert.ok(queued.has(partial.id), 'missing dimensions (language/vocal/version) make it a candidate');
  assert.ok(!queued.has(complete.id)); assert.ok(!queued.has(story.id));
  assert.equal((await svc.backfill.status()).status, 'completed');
});

test('large library: cursor pagination, bounded batches, every track exactly once', async () => {
  const { svc, db, fake } = await seededService({ providers: [noop], env: { CLASSIFICATION_BACKFILL_MAX_PENDING: '100000' } });
  for (let i = 0; i < 1234; i++) addTrack(db, { title: `T${i}`, artist_or_narrator: 'X' });
  const limits = []; const orig = fake.rpc;
  fake.rpc = (n, a) => { if (n === 'classification_backfill_candidates') limits.push(a.p_limit); return orig(n, a); };
  await svc.backfill.start({ batchSize: 100 });
  let ticks = 0;
  while (!(await svc.backfill.tick()).done) ticks++;
  assert.equal(db.music_classification_jobs.length, 1234);
  assert.equal(new Set(db.music_classification_jobs.map((j) => j.music_id)).size, 1234, 'no duplicates');
  assert.ok(limits.every((l) => l <= 100), 'never asks for more than one batch');
  assert.equal(ticks, 13);
  const st = await svc.backfill.status();
  assert.equal(st.stats.enqueued, 1234); assert.equal(st.stats.scanned, 1234);
});

test('batch size is clamped to 1..100', async () => {
  const { svc } = await seededService({ providers: [noop] });
  assert.equal((await svc.backfill.start({ batchSize: 5000 })).batch_size, 100);
  await svc.backfill.cancel();
  assert.equal((await svc.backfill.start({ batchSize: 0 })).batch_size, 50, 'falls back to the configured default');
});

test('resume after a restart: state lives in the database, a brand-new process continues from the cursor', async () => {
  const a = await seededService({ providers: [noop], env: { CLASSIFICATION_BACKFILL_MAX_PENDING: '100000' } });
  for (let i = 0; i < 230; i++) addTrack(a.db, { title: `T${i}`, artist_or_narrator: 'X' });
  await a.svc.backfill.start({ batchSize: 50 });
  await a.svc.backfill.tick(); await a.svc.backfill.tick();
  assert.equal(a.db.music_classification_jobs.length, 100);
  const cursorBefore = (await a.svc.backfill.status()).cursor_id;

  // "restart": new service objects, same database
  const svc2 = createService({ supabase: a.fake, config: a.cfg, providers: [noop], log() {} });
  const st = await svc2.backfill.status();
  assert.equal(st.status, 'running'); assert.equal(st.cursor_id, cursorBefore);
  while (!(await svc2.backfill.tick()).done) { /* drain */ }
  assert.equal(a.db.music_classification_jobs.length, 230);
  assert.equal(new Set(a.db.music_classification_jobs.map((j) => j.music_id)).size, 230);
});

test('pause stops progress; resume continues; cancel ends it; only one backfill may be active', async () => {
  const { svc, db } = await seededService({ providers: [noop], env: { CLASSIFICATION_BACKFILL_MAX_PENDING: '100000' } });
  for (let i = 0; i < 120; i++) addTrack(db, { title: `T${i}`, artist_or_narrator: 'X' });
  await svc.backfill.start({ batchSize: 50 });
  await assert.rejects(() => svc.backfill.start({}), /already running or paused/);
  await svc.backfill.tick();
  await svc.backfill.pause();
  assert.deepEqual(await svc.backfill.tick(), { ran: false, reason: 'paused' });
  assert.equal(db.music_classification_jobs.length, 50);
  await assert.rejects(() => svc.backfill.pause(), /cannot move/);
  await svc.backfill.resume();
  await svc.backfill.tick();
  assert.equal(db.music_classification_jobs.length, 100);
  await svc.backfill.cancel();
  assert.equal((await svc.backfill.status()).status, 'cancelled');
  assert.equal((await svc.backfill.tick()).ran, false);
  await svc.backfill.start({}); // a new one may start after cancelling
});

test('dry run walks the library and reports, but enqueues nothing', async () => {
  const { svc, db } = await seededService({ providers: [noop] });
  for (let i = 0; i < 75; i++) addTrack(db, { title: `T${i}`, artist_or_narrator: 'X' });
  await svc.backfill.start({ dryRun: true, batchSize: 50 });
  while (!(await svc.backfill.tick()).done) { /* drain */ }
  const st = await svc.backfill.status();
  assert.equal(db.music_classification_jobs.length, 0);
  assert.equal(st.stats.would_enqueue, 75); assert.equal(st.stats.enqueued, 0); assert.equal(st.stats.sample.length, 20); assert.equal(st.status, 'completed');
});

test('backpressure: no new batch while the queue is full', async () => {
  const { svc, db } = await seededService({ providers: [noop], env: { CLASSIFICATION_BACKFILL_MAX_PENDING: '60' } });
  for (let i = 0; i < 200; i++) addTrack(db, { title: `T${i}`, artist_or_narrator: 'X' });
  await svc.backfill.start({ batchSize: 50 });
  assert.equal((await svc.backfill.tick()).ran, true);
  assert.equal((await svc.backfill.tick()).ran, true);   // 50 < 60 -> allowed, now 100 pending
  const r = await svc.backfill.tick();
  assert.equal(r.ran, false); assert.match(r.reason, /backpressure/);
});

test('tracks that already have an open job are not queued twice', async () => {
  const { svc, db } = await seededService({ providers: [noop] });
  const a = addTrack(db, { title: 'A', artist_or_narrator: 'X' }); addTrack(db, { title: 'B', artist_or_narrator: 'X' });
  await svc.queue.enqueue(a.id, { reason: 'upload' });
  await svc.backfill.start({});
  while (!(await svc.backfill.tick()).done) { /* drain */ }
  assert.equal(db.music_classification_jobs.length, 2);
});

test('end to end: backfill + worker classify the whole library; a second backfill finds nothing (idempotent); reclassify-all runs everything again', async () => {
  const mb = stubProvider('musicbrainz', async () => ({ observations: [{ key: 'genre:jazz', group: 'musicbrainz', p: 0.99, scope: 'recording', note: 'x' }], meta: {}, source: null }));
  const { svc, db } = await seededService({ providers: [mb], env: { CLASSIFICATION_BACKFILL_MAX_PENDING: '100000' } });
  for (let i = 0; i < 60; i++) addTrack(db, { title: `T${i}`, artist_or_narrator: 'X' });
  addTrack(db, { type: 'audio_story', title: 'Katha' });
  await svc.backfill.start({ batchSize: 25 });
  await svc.worker.runUntilIdle({ deadlineMs: 8000 });       // maintenance ticks the backfill, jobs get processed
  while ((await svc.backfill.active())) { await svc.worker.runUntilIdle({ deadlineMs: 8000 }); }
  assert.equal(db.music_classification_metadata.length, 60);
  assert.equal(db.music_classification_jobs.filter((j) => j.status === 'pending').length, 0);

  // second pass: tracks were attempted for every required dimension -> nothing to do
  await svc.backfill.start({});
  assert.equal((await svc.backfill.tick()).done, true);
  assert.equal((await svc.backfill.status()).stats.enqueued, 0);

  // explicit reclassification of the whole library
  await svc.reclassify({ all: true });
  while (!(await svc.backfill.tick()).done) { /* drain */ }
  assert.equal(db.music_classification_jobs.filter((j) => j.reason === 'reclassify').length, 60);
});

test('older classification versions can be re-processed via minVersion; manual labels survive the re-run', async () => {
  const mb = stubProvider('musicbrainz', async () => ({ observations: [{ key: 'genre:jazz', group: 'musicbrainz', p: 0.99, scope: 'recording', note: 'x' }], meta: {}, source: null }));
  const { svc, db, cfg } = await seededService({ providers: [mb] });
  const t = addTrack(db, { title: 'Song', artist_or_narrator: 'X' });
  await svc.engine.classifyTrack(t.id);
  await svc.manualLabel(t.id, { key: 'genre:jazz', action: 'reject' });
  db.music_classification_metadata[0].classification_version = 0;
  await svc.backfill.start({ minVersion: cfg.version });
  while (!(await svc.backfill.tick()).done) { /* drain */ }
  assert.equal(db.music_classification_jobs.length, 1);
  await svc.worker.runUntilIdle({ deadlineMs: 2000 });
  const row = db.music_track_labels.find((r) => r.label_id === labelId(db, 'genre:jazz'));
  assert.equal(row.status, 'rejected'); assert.equal(row.is_manual, true);
});

test('duplicate records (same title/artist) are each classified, provider results are cached', async () => {
  let calls = 0;
  const { svc, db } = await seededService({ providers: [stubProvider('musicbrainz', async (track, ctx) => {
    const { payload } = await ctx.cache.getOrFetch('musicbrainz', `k|${track.base}`, async () => { calls++; return { ok: true }; });
    return { observations: [], meta: {}, source: null, payload };
  })] });
  const a = addTrack(db, { title: 'Same', artist_or_narrator: 'X' }); const b = addTrack(db, { title: 'Same', artist_or_narrator: 'X' });
  await svc.engine.classifyTrack(a.id); await svc.engine.classifyTrack(b.id);
  assert.equal(calls, 1, 'second duplicate used the cache');
  assert.equal(db.music_classification_metadata.length, 2);
});
