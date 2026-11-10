'use strict';
process.env.JWT_SECRET = 'test-secret';
process.env.TOKEN_ENC_KEY = '0'.repeat(64);

/**
 * Admin editing of automatic labels: change-only (fixed vocabulary, same kind), the library listing
 * for the admin screen, the "no hand-made music labels" guard, and the no-Render-bandwidth audio link.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { seededService, addTrack, stubProvider } = require('./harness');
const { createRouter } = require('../../routes/classification');
const { makeAudioLink } = require('../../lib/classification/service');

const admin = jwt.sign({ sub: 'admin-1', role: 'admin' }, 'test-secret');
const obs = (key, g, p) => ({ key, group: g, p, scope: 'recording', note: key });

let ctx; let server; let base; let t1; let t2; let ids = {};
test.before(async () => {
  ctx = await seededService({ providers: [stubProvider('musicbrainz', async () => ({ observations: [obs('genre:bollywood', 'musicbrainz', 0.99), obs('genre:jazz', 'musicbrainz', 0.2), obs('mood:calm', 'musicbrainz', 0.6), obs('mood:calm', 'lastfm', 0.5)], meta: {}, source: null }))] });
  ctx.db.content_labels ||= [];
  ctx.db.content_labels.push({ id: 'cl-bolly', name: 'Bollywood', applies_to: 'music', is_active: true }, { id: 'cl-folk', name: 'Folk', applies_to: 'music', is_active: true });
  t1 = addTrack(ctx.db, { title: 'Tum Hi Ho', artist_or_narrator: 'Arijit Singh' });
  t2 = addTrack(ctx.db, { title: 'Second Song', artist_or_narrator: 'Someone' });
  const app = express(); app.use(express.json());
  app.use('/api/classification', createRouter({ getService: () => ctx.svc, supabase: ctx.fake }));
  server = http.createServer(app); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api/classification`;
  for (const t of [t1, t2]) { await ctx.svc.reclassify({ ids: [t.id] }); }
  await ctx.svc.worker.runUntilIdle({ deadlineMs: 3000 });
  const vocab = (await (await fetch(base + '/labels', { headers: { Authorization: `Bearer ${admin}` } })).json()).labels;
  const id = (dim, slug) => vocab.find((l) => l.dimension === dim && l.slug === slug).id;
  ids = { bollywood: id('genre', 'bollywood'), folk: id('genre', 'folk'), calm: id('mood', 'calm'), hindi: id('language', 'hindi') };
});
test.after(() => server.close());

const call = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test('change a genre: new label approved + manual, old one removed, legacy category follows', async () => {
  const r = await call('POST', `/tracks/${t1.id}/labels/change`, { fromLabelId: ids.bollywood, toLabelId: ids.folk });
  assert.equal(r.status, 200); assert.equal(r.body.dimension, 'genre');
  const d = (await call('GET', `/tracks/${t1.id}`)).body;
  const folk = d.labels.find((l) => l.key === 'genre:folk'); const bolly = d.labels.find((l) => l.key === 'genre:bollywood');
  assert.equal(folk.status, 'approved'); assert.equal(folk.manual, true); assert.equal(folk.evidence.actor, 'admin-1');
  assert.equal(bolly.status, 'rejected'); assert.equal(bolly.manual, true);
  assert.equal(ctx.db.media_items.find((m) => m.id === t1.id).category, 'Folk');
  assert.equal(ctx.db.media_items.find((m) => m.id === t1.id).content_label_id, 'cl-folk');
});

test('a manual change survives reclassification', async () => {
  await call('POST', `/tracks/${t1.id}/reclassify`, {});
  await ctx.svc.worker.runUntilIdle({ deadlineMs: 3000 });
  const d = (await call('GET', `/tracks/${t1.id}`)).body;
  assert.equal(d.labels.find((l) => l.key === 'genre:folk').status, 'approved');
  assert.equal(d.labels.find((l) => l.key === 'genre:bollywood').status, 'rejected');
});

test('change is restricted: same kind only, real vocabulary only, label must be assigned', async () => {
  assert.equal((await call('POST', `/tracks/${t2.id}/labels/change`, { fromLabelId: ids.bollywood, toLabelId: ids.calm })).status, 400, 'genre -> mood is refused');
  assert.equal((await call('POST', `/tracks/${t2.id}/labels/change`, { fromLabelId: ids.bollywood, toLabelId: ids.bollywood })).status, 400);
  assert.equal((await call('POST', `/tracks/${t2.id}/labels/change`, { fromLabelId: ids.bollywood, toLabelId: '00000000-0000-4000-8000-0000000000aa' })).status, 400, 'unknown label id');
  assert.equal((await call('POST', `/tracks/${t2.id}/labels/change`, { fromLabelId: ids.bollywood, toLabelId: 'nope' })).status, 400);
  assert.equal((await call('POST', `/tracks/${t2.id}/labels/change`, { fromLabelId: ids.folk, toLabelId: ids.bollywood })).status, 404, 'folk is not on this track');
  assert.equal((await call('POST', '/tracks/00000000-0000-4000-8000-0000000000fe/labels/change', { fromLabelId: ids.bollywood, toLabelId: ids.folk })).status, 404);
});

test('library lists music with labels (no rejected ones); attention=1 lists only tracks awaiting review', async () => {
  const all = (await call('GET', '/library?limit=10')).body;
  const row = all.items.find((i) => i.id === t1.id);
  assert.ok(row); assert.equal(row.title, 'Tum Hi Ho'); assert.ok(!row.labels.some((l) => l.name === 'Bollywood'), 'rejected labels are hidden');
  const folk = row.labels.find((l) => l.name === 'Folk'); assert.equal(folk.manual, true); assert.equal(folk.dimension, 'genre');
  assert.ok(!JSON.stringify(all).includes('cover'), 'no cover/audio data in this listing');
  const att = (await call('GET', '/library?attention=1')).body;
  assert.ok(att.items.length >= 1 && att.items.every((i) => i.labels.some((l) => l.status === 'provisional' || l.status === 'needs_review')));
  assert.equal((await call('GET', '/library?labelId=bad')).status, 400);
  const byLabel = (await call('GET', `/library?labelId=${ids.folk}`)).body;
  assert.deepEqual(byLabel.items.map((i) => i.id), [t1.id]);
});

test('admins cannot hand-create music labels (they are automatic); story labels still work', async () => {
  ctx.db.content_labels ||= [];
  require.cache[require.resolve('../../lib/supabaseClient')] = { id: 'x', filename: 'x', loaded: true, exports: ctx.fake };
  const labels = require('../../routes/labels');
  const app = express(); app.use(express.json()); app.use('/api/labels', labels);
  const s = http.createServer(app); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${s.address().port}/api/labels`;
  const post = (b) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` }, body: JSON.stringify(b) });
  try {
    for (const appliesTo of ['music', 'both']) { const r = await post({ name: 'Brand New', appliesTo }); assert.equal(r.status, 403); assert.match((await r.json()).error, /automatic/i); }
    const ok = await post({ name: 'Thriller Stories', appliesTo: 'audio_story' });
    assert.equal(ok.status, 200, 'audio-story labels are untouched');
  } finally { s.close(); }
});

test('the audio-analysis link never points at the Render backend', async () => {
  await assert.rejects(() => makeAudioLink({ AUDIO_CDN_BASE_URL: '' })('abc', 60), /refusing to send audio through the Render backend/);
  const url = await makeAudioLink({ AUDIO_CDN_BASE_URL: 'https://audio.example.workers.dev/' })('abc', 60);
  assert.match(url, /^https:\/\/audio\.example\.workers\.dev\/api\/storage\/stream\/abc\?token=/);
});

test('the old Groq backfill leaves music to the classification engine', async () => {
  const fake = require('./harness').makeDb();
  require.cache[require.resolve('../../lib/supabaseClient')] = { id: 'x', filename: 'x', loaded: true, exports: fake };
  delete require.cache[require.resolve('../../lib/autoCategorize')];
  const auto = require('../../lib/autoCategorize');
  fake.db.media_items.push({ id: 'm1', type: 'music', category: null }, { id: 's1', type: 'audio_story', category: null });
  const res = await auto.backfillMissingCategories();
  assert.equal(res.total, 1, 'only the audio story is a candidate; the music track is left to the engine');
});
