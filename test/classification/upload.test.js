'use strict';
/**
 * New-upload workflow, driven through the REAL routes/media.js create handler over HTTP
 * (database = the in-memory double). The classification singleton is the real one.
 */
process.env.JWT_SECRET = 'test-secret';
process.env.TOKEN_ENC_KEY = '0'.repeat(64);
delete process.env.CLASSIFICATION_ENABLED;
process.env.CLASSIFICATION_LOG_LEVEL = 'silent';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { makeDb } = require('./harness');

const fake = makeDb();
const { db } = fake;
require.cache[require.resolve('../../lib/supabaseClient')] = { id: 'x', filename: 'x', loaded: true, exports: fake };

const autoCategorize = require('../../lib/autoCategorize');
const autoCalls = [];
autoCategorize.autoCategorizeIfMissing = async (id) => { autoCalls.push(id); };

const hooks = require('../../lib/classification/hooks');
const mediaRouter = require('../../routes/media');
const { getService } = require('../../lib/classification/service');

const adminToken = jwt.sign({ sub: 'admin-1', role: 'admin' }, 'test-secret');
let server; let base;
test.before(async () => {
  const app = express(); app.use(express.json()); app.use('/api/media', mediaRouter);
  server = http.createServer(app); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await getService().store.ensureTaxonomy();
});
test.after(() => server.close());

const post = async (body) => {
  const r = await fetch(`${base}/api/media`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
let n = 0;
const music = (extra = {}) => { n++; return { type: 'music', title: `Song ${n}`, artistOrNarrator: 'Arijit Singh', albumOrSeries: 'Some Album', releaseYear: 2020, durationSeconds: 240, fileSizeBytes: 5e6,
  storageProvider: 'drime', storageAccountId: 'acc-1', storageFileId: `f${n}`, storageHash: `h${n}`, storagePath: `songs/s${n}.mp3`, ...extra }; };
const jobsFor = (id) => db.music_classification_jobs.filter((j) => j.music_id === id);
const tick = () => new Promise((r) => setTimeout(r, 30));

test('a successful music upload creates one classification job and returns normally', async () => {
  const r = await post(music());
  assert.equal(r.status, 200);
  await tick();
  const jobs = jobsFor(r.body.item.id);
  assert.equal(jobs.length, 1); assert.equal(jobs[0].status, 'pending'); assert.equal(jobs[0].reason, 'upload');
  assert.equal(autoCalls.includes(r.body.item.id), false, 'music no longer goes through the old categorizer');
});

test('the upload response never waits for classification (nothing ran, job is just queued)', async () => {
  const r = await post(music());
  await tick();
  assert.equal(db.music_classification_metadata.some((m) => m.music_id === r.body.item.id), false);
  assert.equal(db.music_track_labels.some((l) => l.music_id === r.body.item.id), false);
});

test('failed uploads (validation / lookup errors) enqueue nothing', async () => {
  const before = db.music_classification_jobs.length;
  assert.equal((await post({ ...music(), storageHash: undefined })).status, 400);
  assert.equal((await post({ ...music(), storageProvider: 's3' })).status, 400);
  assert.equal((await post({ ...music(), title: undefined })).status, 400);
  assert.equal((await post({ ...music(), albumId: '00000000-0000-4000-8000-00000000dead' })).status, 400);
  assert.equal((await post({ ...music(), type: 'podcast' })).status, 400);
  await tick();
  assert.equal(db.music_classification_jobs.length, before);
});

test('an insert that fails after validation enqueues nothing', async () => {
  const before = db.music_classification_jobs.length;
  const origFrom = fake.from;
  fake.from = (t) => { const b = origFrom(t); if (t === 'media_items') { const oi = b.insert; b.insert = (p) => { const x = oi(p); x.then = (res) => Promise.resolve({ data: null, error: { message: 'disk full' } }).then(res); return x; }; } return b; };
  try { assert.equal((await post(music())).status, 500); } finally { fake.from = origFrom; }
  await tick();
  assert.equal(db.music_classification_jobs.length, before);
});

test('enqueue failure (e.g. migration not applied) never breaks the upload', async () => {
  const origFrom = fake.from;
  fake.from = (t) => { if (t === 'music_classification_jobs') throw new Error('relation "music_classification_jobs" does not exist'); return origFrom(t); };
  let r;
  try { r = await post(music()); } finally { fake.from = origFrom; }
  assert.equal(r.status, 200);
  assert.ok(db.media_items.some((m) => m.id === r.body.item.id));
  await tick();
  // the track has no job and no metadata, so the historical backfill will discover it later
  const svc = getService();
  const ids = (await svc.backfill.start({ dryRun: true }), (await fake.rpc('classification_backfill_candidates', { p_after: null, p_limit: 1000, p_required: ['genre'], p_min_version: 0 })).data.map((x) => x.id));
  await svc.backfill.cancel();
  assert.ok(ids.includes(r.body.item.id));
});

test('hooks never reject, even when the service cannot be built', async () => {
  const svcMod = require('../../lib/classification/service');
  const orig = svcMod.getService;
  svcMod.getService = () => { throw new Error('boom'); };
  try { const r = await hooks.enqueueNewMusic('whatever'); assert.equal(r.created, false); assert.match(r.error, /boom/); } finally { svcMod.getService = orig; }
});

test('uploads with missing artist are queued and classified without provider matching', async () => {
  const r = await post(music({ artistOrNarrator: undefined, albumOrSeries: undefined }));
  assert.equal(r.status, 200);
  const svc = getService(); await svc.worker.runUntilIdle({ deadlineMs: 3000 });
  assert.ok(jobsFor(r.body.item.id)[0].status !== 'pending');
  assert.ok(db.music_classification_metadata.some((m) => m.music_id === r.body.item.id));
});

test('duplicate uploads: each row gets exactly one job; the same track is never queued twice', async () => {
  const body = music();
  const [a, b] = await Promise.all([post(body), post({ ...body, storageFileId: 'dup-2', storageHash: 'dup-h2' })]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  await tick();
  assert.equal(jobsFor(a.body.item.id).length, 1); assert.equal(jobsFor(b.body.item.id).length, 1);
  const again = await hooks.enqueueNewMusic(a.body.item.id);
  assert.equal(again.created, false);
  assert.equal(jobsFor(a.body.item.id).length, 1);
});

test('concurrent uploads: every track gets one job', async () => {
  const rs = await Promise.all(Array.from({ length: 12 }, () => post(music())));
  assert.ok(rs.every((r) => r.status === 200));
  await tick();
  const ids = rs.map((r) => r.body.item.id);
  assert.equal(new Set(ids).size, 12);
  for (const id of ids) assert.equal(jobsFor(id).length, 1);
});

test('all supported file formats are queued and classified', async () => {
  const ids = [];
  for (const ext of ['mp3', 'flac', 'm4a', 'wav', 'ogg', 'aac', 'opus']) {
    const r = await post(music({ storagePath: `songs/track.${ext}`, title: `Format ${ext}` })); assert.equal(r.status, 200); ids.push(r.body.item.id);
  }
  await getService().worker.runUntilIdle({ deadlineMs: 5000 });
  for (const id of ids) assert.ok(db.music_classification_metadata.some((m) => m.music_id === id), id);
});

test('audio stories are not classified as music (they keep the Groq categorizer)', async () => {
  const before = db.music_classification_jobs.length; autoCalls.length = 0;
  const r = await post({ type: 'audio_story', storyTitle: 'Panchtantra', chapterNumber: 1, artistOrNarrator: 'Narrator', durationSeconds: 600, fileSizeBytes: 1e6,
    storageProvider: 'drime', storageAccountId: 'acc-1', storageFileId: 'st1', storageHash: 'sth1', storagePath: 'stories/1.mp3' });
  assert.equal(r.status, 200); await tick();
  assert.equal(db.music_classification_jobs.length, before);
  assert.deepEqual(autoCalls, [r.body.item.id]);
});

test('classification failure leaves the media row, its legacy label and listing intact', async () => {
  const r = await post(music());
  const svc = getService();
  const origClassify = svc.engine.classifyTrack;
  svc.engine.classifyTrack = async () => { throw new Error('classifier exploded'); };
  try { await svc.worker.runUntilIdle({ deadlineMs: 2000 }); } finally { svc.engine.classifyTrack = origClassify; }
  const row = db.media_items.find((m) => m.id === r.body.item.id);
  assert.ok(row && row.storage_file_id && row.title);
  const list = await fetch(`${base}/api/media?type=music`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(list.status, 200);
});

test('CLASSIFICATION_ENABLED=off disables queuing and restores the previous behaviour for music', async () => {
  process.env.CLASSIFICATION_ENABLED = 'off';
  try {
    const before = db.music_classification_jobs.length; autoCalls.length = 0;
    const r = await post(music());
    await tick();
    assert.equal(db.music_classification_jobs.length, before);
    assert.deepEqual(autoCalls, [r.body.item.id]);
  } finally { delete process.env.CLASSIFICATION_ENABLED; }
});
