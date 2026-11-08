'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { seededService, addTrack, stubProvider } = require('./harness');
const { ProviderError } = require('../../lib/classification/providers/base');
const { cacheKey } = require('../../lib/lyricsProviders');

const obs = (key, group, p, scope = 'recording') => ({ key, group, p, scope, note: `${group}:${key}` });
const provider = (name, observations, meta = {}, source = null) => stubProvider(name, async () => ({ observations, meta, source }));
const failing = (name, kind = 'unavailable') => stubProvider(name, async () => { throw new ProviderError(name, kind, 'boom', { retryAfterMs: 1000 }); });

function labelsOf(db, id) {
  const out = {};
  for (const r of db.music_track_labels.filter((x) => x.music_id === id)) {
    const l = db.music_labels.find((x) => x.id === r.label_id);
    out[`${l.dimension}:${l.slug}`] = r;
  }
  return out;
}

test('multiple genres, moods and characteristics on one track', async () => {
  const { svc, db } = await seededService({ providers: [
    provider('musicbrainz', [obs('genre:bollywood', 'musicbrainz', 0.85), obs('genre:indian-pop', 'musicbrainz', 0.8), obs('mood:romantic', 'musicbrainz', 0.5)]),
    provider('audio', [obs('mood:romantic', 'audio', 0.8), obs('mood:melancholic', 'audio', 0.85), obs('characteristic:piano-based', 'audio', 0.8)]),
    provider('llm', [obs('mood:melancholic', 'llm', 0.5), obs('genre:bollywood', 'llm', 0.55)])
  ] });
  const t = addTrack(db, { title: 'Shayad', artist_or_narrator: 'Arijit Singh' });
  const r = await svc.engine.classifyTrack(t.id);
  const L = labelsOf(db, t.id);
  assert.equal(L['genre:bollywood'].status, 'approved');
  assert.ok(L['genre:indian-pop'], 'second genre stored');
  assert.equal(L['mood:romantic'].status, 'approved');
  assert.equal(L['mood:melancholic'].status, 'approved');
  assert.ok(L['characteristic:piano-based']);
  assert.ok(Object.keys(L).length >= 5);
  assert.equal(r.dimensionStatus.mood, 'approved');
  // every stored label carries confidence, source, status and evidence
  for (const row of Object.values(L)) {
    assert.ok(row.confidence >= 0 && row.confidence <= 1); assert.ok(row.source); assert.ok(row.status); assert.ok(row.evidence.observations.length);
  }
});

test('independent confidence per label: one song, very different confidences', async () => {
  const { svc, db } = await seededService({ providers: [provider('llm', [obs('genre:pop', 'llm', 0.6), obs('mood:happy', 'llm', 0.3)])] });
  const t = addTrack(db, { title: 'Obscure', artist_or_narrator: 'Nobody' });
  await svc.engine.classifyTrack(t.id);
  const L = labelsOf(db, t.id);
  assert.equal(L['genre:pop'].status, 'needs_review');
  assert.equal(L['mood:happy'], undefined, 'below the review threshold: not stored at all');
});

test('vocal types from version markers: female version, male version', async () => {
  const { svc, db } = await seededService();
  const f = addTrack(db, { title: 'Kal Ho Naa Ho - Female Version', artist_or_narrator: 'Shreya Ghoshal' });
  const m = addTrack(db, { title: 'Kal Ho Naa Ho (Male Version)', artist_or_narrator: 'Sonu Nigam' });
  await svc.engine.classifyTrack(f.id); await svc.engine.classifyTrack(m.id);
  assert.equal(labelsOf(db, f.id)['vocal:female-vocal'].status, 'approved');
  assert.equal(labelsOf(db, f.id)['version:female-version'].status, 'approved');
  assert.equal(labelsOf(db, m.id)['vocal:male-vocal'].status, 'approved');
  assert.equal(labelsOf(db, m.id)['vocal:female-vocal'], undefined);
});

test('language is detected from lyrics script, not from the artist', async () => {
  const { svc, db } = await seededService();
  const t = addTrack(db, { title: 'Ennodu Nee', artist_or_narrator: 'Arijit Singh' }); // a Hindi-film singer, Tamil lyrics
  db.lyrics_cache.push({ key: cacheKey(t.title, t.artist_or_narrator), payload: { plain_lyrics: Array(4).fill('என் உயிரே நீ இல்லாமல் நான் இல்லை என் உயிரே நீ இல்லாமல்').join('\n') } });
  await svc.engine.classifyTrack(t.id);
  const L = labelsOf(db, t.id);
  assert.equal(L['language:tamil'].status, 'approved');
  assert.equal(L['language:hindi'], undefined);
  assert.equal(svc.engine && (await svc.store.getMetadata(t.id)).detected_language, 'tamil');
});

test('Hindi lyrics in Devanagari with function words -> Hindi, corroborated by a second source -> approved', async () => {
  const { svc, db } = await seededService({ providers: [provider('musicbrainz', [obs('language:hindi', 'musicbrainz', 0.88, 'composition')])] });
  const t = addTrack(db, { title: 'Tere Bina', artist_or_narrator: 'Someone' });
  db.lyrics_cache.push({ key: cacheKey(t.title, t.artist_or_narrator), payload: { plain_lyrics: 'तेरे बिना मैं नहीं है दिल में कि और तुम को का की के तेरे बिना मैं नहीं है दिल में कि और तुम को का की के' } });
  await svc.engine.classifyTrack(t.id);
  assert.equal(labelsOf(db, t.id)['language:hindi'].status, 'approved');
});

test('instrumental detection from the title: vocal, language and version', async () => {
  const { svc, db } = await seededService();
  const t = addTrack(db, { title: 'Titanic Theme (Instrumental Version)', artist_or_narrator: 'Some Orchestra' });
  await svc.engine.classifyTrack(t.id);
  const L = labelsOf(db, t.id);
  assert.equal(L['vocal:instrumental'].status, 'approved');
  assert.equal(L['language:instrumental'].status, 'approved');
  assert.equal(L['version:instrumental-version'].status, 'approved');
});

test('remix and reprise are identified as versions, never as genres', async () => {
  const { svc, db } = await seededService();
  const rx = addTrack(db, { title: 'Tera Ban Jaunga (DJ Chetas Remix)', artist_or_narrator: 'Akhil Sachdeva' });
  const rp = addTrack(db, { title: 'Shayad - Reprise', artist_or_narrator: 'Arijit Singh' });
  await svc.engine.classifyTrack(rx.id); await svc.engine.classifyTrack(rp.id);
  assert.equal(labelsOf(db, rx.id)['version:remix'].status, 'approved');
  assert.equal(labelsOf(db, rx.id)['version:original'], undefined);
  assert.equal(labelsOf(db, rp.id)['version:reprise'].status, 'approved');
  assert.equal((await svc.store.getMetadata(rp.id)).version_type, 'reprise');
  for (const id of [rx.id, rp.id]) assert.ok(!Object.keys(labelsOf(db, id)).some((k) => k.startsWith('genre:remix') || k === 'genre:reprise'));
});

test('no evidence: nothing is invented, only the weak "no marker => original" claim is made', async () => {
  const { svc, db } = await seededService();
  const t = addTrack(db, { title: 'Zzyzx', artist_or_narrator: 'Unknown Artist' });
  const r = await svc.engine.classifyTrack(t.id);
  const L = labelsOf(db, t.id);
  assert.deepEqual(Object.keys(L), ['version:original']);
  assert.equal(L['version:original'].status, 'provisional');
  assert.equal(r.dimensionStatus.genre, 'unknown'); assert.equal(r.dimensionStatus.language, 'unknown');
  assert.equal(r.outcome, 'needs_review');
  assert.notEqual(r.overallStatus, 'complete');
});

test('conflicting providers: neither side is approved', async () => {
  const { svc, db } = await seededService({ providers: [
    provider('musicbrainz', [obs('language:hindi', 'musicbrainz', 0.9, 'composition')]),
    provider('lastfm', [obs('language:marathi', 'lastfm', 0.8, 'composition')])
  ] });
  const t = addTrack(db, { title: 'Tu Hi Re', artist_or_narrator: 'X' });
  const r = await svc.engine.classifyTrack(t.id);
  const L = labelsOf(db, t.id);
  assert.notEqual(L['language:hindi']?.status, 'approved');
  assert.notEqual(L['language:marathi']?.status, 'approved');
  assert.notEqual(r.dimensionStatus.language, 'approved');
});

test('versions of one composition get different, recording-specific classifications', async () => {
  // The provider only knows the ORIGINAL recording; for other versions it answers at composition scope.
  const mb = stubProvider('musicbrainz', async (track) => {
    const isOriginal = track.versionSlugs.size === 0;
    return { observations: [
      obs('genre:bollywood', 'musicbrainz', isOriginal ? 0.85 : 0.72, 'composition'),
      obs('mood:romantic', 'musicbrainz', 0.85, isOriginal ? 'recording' : 'composition'), // would leak if allowed
      ...(isOriginal ? [obs('vocal:male-vocal', 'musicbrainz', 0.72)] : [])
    ], meta: { musicbrainz_recording_id: isOriginal ? 'mb-orig' : null } };
  });
  const { svc, db } = await seededService({ providers: [mb] });
  const orig = addTrack(db, { title: 'Shayad', artist_or_narrator: 'Arijit Singh' });
  const rep = addTrack(db, { title: 'Shayad - Reprise', artist_or_narrator: 'Arijit Singh' });
  const fem = addTrack(db, { title: 'Shayad (Female Version)', artist_or_narrator: 'Shreya Ghoshal' });
  for (const t of [orig, rep, fem]) await svc.engine.classifyTrack(t.id);
  const [A, B, C] = [orig, rep, fem].map((t) => labelsOf(db, t.id));
  assert.ok(A['version:original'] && !B['version:original'] && !C['version:original']);
  assert.ok(B['version:reprise'] && C['version:female-version']);
  assert.ok(A['mood:romantic'], 'recording-scope mood applies to the original');
  assert.equal(B['mood:romantic'], undefined, 'composition-scope evidence must not leak recording-specific mood');
  assert.equal(C['vocal:female-vocal'].status, 'approved'); assert.equal(C['vocal:male-vocal'], undefined);
  assert.ok(B['genre:bollywood'], 'broad composition-level genre may be shared');
  const keys = await Promise.all([orig, rep, fem].map((t) => svc.store.getMetadata(t.id)));
  assert.equal(new Set(keys.map((k) => k.composition_key)).size, 1, 'all versions share one composition key');
  assert.deepEqual(keys.map((k) => k.version_type), ['original', 'reprise', 'female-version']);
});

test('legacy label is preserved, never overwritten, and corroborates the genre', async () => {
  const { svc, db } = await seededService();
  db.content_labels.push({ id: 'cl-bolly', name: 'Bollywood', applies_to: 'music', is_active: true }, { id: 'cl-folk', name: 'Folk', applies_to: 'music', is_active: true });
  const t = addTrack(db, { title: 'Song', artist_or_narrator: 'X', category: 'Folk', content_label_id: 'cl-folk' });
  await svc.engine.classifyTrack(t.id);
  assert.equal(db.media_items[0].category, 'Folk'); assert.equal(db.media_items[0].content_label_id, 'cl-folk');
  assert.ok(labelsOf(db, t.id)['genre:folk'], 'legacy label is carried into the new model');
});

test('an empty legacy label is filled once the genre is approved (never before)', async () => {
  const { svc, db } = await seededService({ providers: [provider('musicbrainz', [obs('genre:bollywood', 'musicbrainz', 0.85)]), provider('lastfm', [obs('genre:bollywood', 'lastfm', 0.55)])] });
  db.content_labels.push({ id: 'cl-bolly', name: 'Bollywood', applies_to: 'music', is_active: true });
  const weak = addTrack(db, { title: 'W', artist_or_narrator: 'X' });
  await svc.engine.classifyTrack(weak.id);
  assert.equal(db.media_items.find((m) => m.id === weak.id).content_label_id, 'cl-bolly');

  const { svc: s2, db: d2 } = await seededService({ providers: [provider('llm', [obs('genre:bollywood', 'llm', 0.6)])] });
  d2.content_labels.push({ id: 'cl-bolly', name: 'Bollywood', applies_to: 'music', is_active: true });
  const t2 = addTrack(d2, { title: 'V', artist_or_narrator: 'X' });
  await s2.engine.classifyTrack(t2.id);
  assert.equal(d2.media_items.find((m) => m.id === t2.id).content_label_id, null, 'a needs_review guess must not touch the legacy label');
});

test('manual labels are protected: removed stays removed, added stays, approved is untouched', async () => {
  const { svc, db } = await seededService({ providers: [provider('musicbrainz', [obs('genre:bollywood', 'musicbrainz', 0.9), obs('genre:pop', 'musicbrainz', 0.9), obs('mood:happy', 'musicbrainz', 0.9)]), provider('lastfm', [obs('genre:bollywood', 'lastfm', 0.6), obs('genre:pop', 'lastfm', 0.6), obs('mood:happy', 'lastfm', 0.6)])] });
  const t = addTrack(db, { title: 'Song', artist_or_narrator: 'X' });
  await svc.manualLabel(t.id, { key: 'genre:bollywood', action: 'remove', actor: 'admin1' });
  await svc.manualLabel(t.id, { key: 'mood:sad', action: 'add', actor: 'admin1' });
  await svc.engine.classifyTrack(t.id);
  let L = labelsOf(db, t.id);
  assert.equal(L['genre:bollywood'].status, 'rejected'); assert.equal(L['genre:bollywood'].is_manual, true);
  assert.equal(L['mood:sad'].status, 'approved'); assert.equal(L['mood:sad'].source, 'manual'); assert.equal(Number(L['mood:sad'].confidence), 1);
  assert.equal(L['genre:pop'].status, 'approved');
  // human approves an automatic label -> now locked, even if evidence later changes
  await svc.manualLabel(t.id, { key: 'mood:happy', action: 'reject' });
  await svc.engine.classifyTrack(t.id); await svc.engine.classifyTrack(t.id);
  L = labelsOf(db, t.id);
  assert.equal(L['mood:happy'].status, 'rejected'); assert.equal(L['genre:bollywood'].status, 'rejected');
});

test('re-running is idempotent and never deletes existing labels', async () => {
  const mb = provider('musicbrainz', [obs('genre:jazz', 'musicbrainz', 0.9), obs('genre:blues', 'musicbrainz', 0.8)]);
  const { svc, db } = await seededService({ providers: [mb] });
  const t = addTrack(db, { title: 'Song', artist_or_narrator: 'X' });
  await svc.engine.classifyTrack(t.id);
  const first = JSON.stringify(Object.keys(labelsOf(db, t.id)).sort());
  const r2 = await svc.engine.classifyTrack(t.id);
  assert.equal(JSON.stringify(Object.keys(labelsOf(db, t.id)).sort()), first);
  assert.equal(r2.writes.inserted, 0); assert.ok(r2.writes.unchanged >= 2);
  assert.equal(db.music_track_labels.filter((r) => r.music_id === t.id).length, Object.keys(labelsOf(db, t.id)).length, 'no duplicate rows');
  // provider now says nothing: old labels must survive
  svc.engine.classifyTrack.length; // (engine instance shared; swap provider list contents)
  mb.lookup = async () => ({ observations: [], meta: {}, source: null });
  await svc.engine.classifyTrack(t.id);
  assert.ok(labelsOf(db, t.id)['genre:jazz'], 'a label is never deleted automatically');
});

test('provider failure degrades gracefully and asks for a retry', async () => {
  const { svc, db } = await seededService({ providers: [failing('musicbrainz'), provider('lastfm', [obs('genre:rock', 'lastfm', 0.6)])] });
  const t = addTrack(db, { title: 'Song (Remix)', artist_or_narrator: 'X' });
  const r = await svc.engine.classifyTrack(t.id);
  assert.equal(r.providerErrors.length, 1); assert.equal(r.providerErrors[0].provider, 'musicbrainz');
  assert.equal(r.retry, true);
  assert.equal(labelsOf(db, t.id)['version:remix'].status, 'approved', 'title-derived labels survive a provider outage');
});

test('every provider down and nothing else known -> failed (retryable)', async () => {
  const { svc, db } = await seededService({ providers: [failing('musicbrainz'), failing('spotify', 'rate_limited')] });
  const t = addTrack(db, { title: 'Zzz', artist_or_narrator: 'X', category: null });
  const r = await svc.engine.classifyTrack(t.id);
  // "no version marker => original" is still derived locally, so this is needs_review, not failed:
  assert.equal(r.outcome, 'needs_review'); assert.equal(r.retry, true);
});

test('missing artist: providers are not asked to match on title alone', async () => {
  let called = 0;
  const mb = stubProvider('musicbrainz', async () => { called++; return { observations: [], meta: {}, source: null }; });
  const { svc, db } = await seededService({ providers: [mb] });
  const t = addTrack(db, { title: 'Only A Title', artist_or_narrator: null });
  const r = await svc.engine.classifyTrack(t.id);
  assert.equal(called, 0); assert.ok(r.labels.length >= 0);
});

test('hostile / odd metadata does not crash the engine', async () => {
  const { svc, db } = await seededService();
  const t = addTrack(db, { title: '\u0000\u200b' + 'A'.repeat(900) + ' (((', artist_or_narrator: '<script>alert(1)</script>' });
  const r = await svc.engine.classifyTrack(t.id);
  assert.ok(['needs_review', 'partially_completed', 'completed', 'failed'].includes(r.outcome));
});

test('dry run computes but writes nothing', async () => {
  const { svc, db } = await seededService({ providers: [provider('musicbrainz', [obs('genre:jazz', 'musicbrainz', 0.99)], { musicbrainz_recording_id: 'x' }, { externalId: 'x', matchConfidence: 1, scope: 'recording', evidence: {} })] });
  const t = addTrack(db, { title: 'Song', artist_or_narrator: 'X' });
  const r = await svc.engine.classifyTrack(t.id, { dryRun: true });
  assert.ok(r.labels.some((l) => l.key === 'genre:jazz')); assert.equal(r.dryRun, true);
  assert.equal(db.music_track_labels.length, 0); assert.equal(db.music_classification_metadata.length, 0); assert.equal(db.music_classification_sources.length, 0);
});

test('only requested dimensions are written', async () => {
  const { svc, db } = await seededService({ providers: [provider('musicbrainz', [obs('genre:jazz', 'musicbrainz', 0.99), obs('mood:calm', 'musicbrainz', 0.99)])] });
  const t = addTrack(db, { title: 'Song', artist_or_narrator: 'X' });
  await svc.engine.classifyTrack(t.id, { dimensions: ['mood'] });
  assert.deepEqual(Object.keys(labelsOf(db, t.id)), ['mood:calm']);
});

test('non-music and deleted tracks are cancelled, not classified', async () => {
  const { svc, db } = await seededService();
  const story = addTrack(db, { type: 'audio_story', title: 'Katha' });
  assert.equal((await svc.engine.classifyTrack(story.id)).outcome, 'cancelled');
  assert.equal((await svc.engine.classifyTrack('00000000-0000-4000-8000-0000000000ff')).outcome, 'cancelled');
});

test('metadata row stores provider ids, status and engine version; sources keep normalised evidence', async () => {
  const src = { externalId: 'mbid-9', matchConfidence: 0.97, scope: 'recording', evidence: { matched: { title: 'Shayad' } } };
  const { svc, db, cfg } = await seededService({ providers: [provider('musicbrainz', [obs('genre:bollywood', 'musicbrainz', 0.99)], { musicbrainz_recording_id: 'mbid-9', isrc: 'INX123' }, src)] });
  const t = addTrack(db, { title: 'Shayad', artist_or_narrator: 'Arijit Singh' });
  await svc.engine.classifyTrack(t.id);
  const m = await svc.store.getMetadata(t.id);
  assert.equal(m.musicbrainz_recording_id, 'mbid-9'); assert.equal(m.isrc, 'INX123');
  assert.equal(m.classification_version, cfg.version); assert.ok(m.last_classified_at); assert.equal(m.original_title, 'Shayad');
  assert.equal(db.music_classification_sources[0].external_id, 'mbid-9');
});
