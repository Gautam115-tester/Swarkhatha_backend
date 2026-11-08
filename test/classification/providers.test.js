'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const axios = require('axios');
const { makeDb } = require('./harness');
const { load, isConfigured } = require('../../lib/classification/config');
const { createCache } = require('../../lib/classification/cache');
const { createStats } = require('../../lib/classification/stats');
const { createBreaker, createLimiter, runProvider, ProviderError } = require('../../lib/classification/providers/base');
const { createMusicBrainz } = require('../../lib/classification/providers/musicbrainz');
const { createSpotify } = require('../../lib/classification/providers/spotify');
const { createLastfm } = require('../../lib/classification/providers/lastfm');
const { createLlm } = require('../../lib/classification/providers/llm');
const { createAudio } = require('../../lib/classification/providers/audio');
const { buildTrack } = require('../../lib/classification/engine');

const ENV = { MUSICBRAINZ_CONTACT: 'me@example.org', SPOTIFY_CLIENT_ID: 'cid', SPOTIFY_CLIENT_SECRET: 'sec', LASTFM_API_KEY: 'lfkey' };
const track = (title, artist, extra = {}) => buildTrack({ id: 't1', title, artist_or_narrator: artist, albumName: null, duration_seconds: 241, ...extra });
const httpErr = (status, headers = {}) => Object.assign(new Error(`HTTP ${status}`), { response: { status, headers } });

/** axios-like double: handlers = [[matcher(url, opts), responder]] ; records every call */
function fakeHttp(handlers) {
  const calls = [];
  const dispatch = async (method, url, a, b) => {
    const opts = method === 'get' ? a : b; const body = method === 'post' ? a : undefined;
    calls.push({ method, url, params: opts?.params, headers: opts?.headers, body });
    for (const [match, respond] of handlers) if (match(url, opts, body)) { const r = await respond(url, opts, body); return { data: r }; }
    throw httpErr(404);
  };
  return { calls, get: (u, o) => dispatch('get', u, o), post: (u, b, o) => dispatch('post', u, b, o) };
}
function ctxFor(h, env = {}, extra = {}) {
  const config = load({ ...ENV, ...env });
  const fake = makeDb();
  return { config, http: h, cache: createCache({ supabase: fake, config }), stats: createStats({ supabase: fake }), breaker: createBreaker({}), log() {}, ...extra };
}
const keys = (r) => r.observations.map((o) => o.key).sort();

/* ----------------------------------------------------------- MusicBrainz */

const MB_SEARCH = { recordings: [{ id: 'rec-1', title: 'Shayad', length: 241000, disambiguation: '', 'artist-credit': [{ name: 'Arijit Singh', artist: { id: 'art-1', name: 'Arijit Singh' } }], releases: [{ title: 'Love Aaj Kal' }] }] };
const mbHandlers = () => [
  [(u) => u.endsWith('/recording'), () => MB_SEARCH],
  [(u) => u.endsWith('/recording/rec-1'), () => ({ id: 'rec-1', genres: [{ name: 'bollywood', count: 3 }], tags: [{ name: 'romantic', count: 2 }, { name: 'seen live', count: 9 }], isrcs: ['INX1'], relations: [{ work: { id: 'w-1', title: 'Shayad', language: 'hin' } }], 'artist-credit': [{ artist: { id: 'art-1' } }] })],
  [(u) => u.endsWith('/artist/art-1'), () => ({ id: 'art-1', name: 'Arijit Singh', type: 'Person', gender: 'Male' })]
];

test('MusicBrainz: sends a contact User-Agent, matches the recording, extracts genre/language/vocal/version', async () => {
  const h = fakeHttp(mbHandlers());
  const mb = createMusicBrainz({ limiter: createLimiter(0) });
  const r = await mb.lookup(track('Shayad', 'Arijit Singh'), ctxFor(h));
  assert.match(h.calls[0].headers['User-Agent'], /SwarKatha\/1\.0 \( me@example\.org \)/);
  assert.match(h.calls[0].params.query, /recording:"Shayad" AND artist:"Arijit Singh"/);
  assert.equal(h.calls[0].params.fmt, 'json');
  assert.deepEqual(keys(r), ['genre:bollywood', 'language:hindi', 'mood:romantic', 'version:original', 'vocal:male-vocal']);
  assert.equal(r.meta.musicbrainz_recording_id, 'rec-1'); assert.equal(r.meta.isrc, 'INX1'); assert.equal(r.meta.musicbrainz_work_id, 'w-1');
  assert.equal(r.source.scope, 'recording');
  assert.ok(r.observations.every((o) => o.p > 0 && o.p < 1));
  assert.ok(!JSON.stringify(r.observations).includes('seen live'), 'noise tags are not turned into labels');
});

test('MusicBrainz: a different version only lends composition-level facts', async () => {
  const h = fakeHttp(mbHandlers());
  const r = await createMusicBrainz({ limiter: createLimiter(0) }).lookup(track('Shayad (Reprise)', 'Arijit Singh'), ctxFor(h));
  assert.equal(r.source.scope, 'composition');
  assert.ok(r.observations.every((o) => o.scope === 'composition' || o.scope === undefined));
  assert.ok(!keys(r).some((k) => k.startsWith('vocal:') || k.startsWith('version:') || k.startsWith('mood:')));
  assert.ok(keys(r).includes('genre:bollywood'));
});

test('MusicBrainz: wrong artist => no match, no evidence (and no lookup call)', async () => {
  const h = fakeHttp(mbHandlers());
  const r = await createMusicBrainz({ limiter: createLimiter(0) }).lookup(track('Shayad', 'Totally Different'), ctxFor(h));
  assert.deepEqual(r.observations, []); assert.equal(r.source, null);
  assert.equal(h.calls.length, 1, 'only the search ran');
});

test('MusicBrainz: results are cached, including across providers instances', async () => {
  const h = fakeHttp(mbHandlers());
  const ctx = ctxFor(h);
  await createMusicBrainz({ limiter: createLimiter(0) }).lookup(track('Shayad', 'Arijit Singh'), ctx);
  const n = h.calls.length;
  await createMusicBrainz({ limiter: createLimiter(0) }).lookup(track('Shayad', 'Arijit Singh'), ctx);
  assert.equal(h.calls.length, n, 'second lookup made zero HTTP calls');
});

test('MusicBrainz: not configured without a contact (never calls out anonymously)', () => {
  assert.equal(isConfigured(load({}), 'musicbrainz'), false);
  assert.equal(isConfigured(load({ MUSICBRAINZ_CONTACT: 'a@b.c' }), 'musicbrainz'), true);
  assert.equal(isConfigured(load({ MUSICBRAINZ_CONTACT: 'a@b.c', MUSICBRAINZ_ENABLED: 'off' }), 'musicbrainz'), false);
});

test('rate limiter spaces calls by the minimum interval', async () => {
  let t = 0; const slept = [];
  const lim = createLimiter(1100, { now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } });
  await Promise.all([lim.schedule(async () => 1), lim.schedule(async () => 2), lim.schedule(async () => 3)]);
  assert.deepEqual(slept, [1100, 1100]);
});

test('HTTP 503/429 become rate_limited errors, a circuit breaker pauses the provider, other providers are unaffected', async () => {
  const h = fakeHttp([[() => true, () => { throw httpErr(503, { 'retry-after': '7' }); }]]);
  const ctx = ctxFor(h, { CLASSIFY_BREAKER_FAILURES: '2' });
  ctx.breaker = createBreaker({ failures: 2, cooldownMs: 60000 });
  const mb = Object.assign(createMusicBrainz({ limiter: createLimiter(0) }), {});
  const a = await runProvider(mb, track('Shayad', 'Arijit Singh'), ctx);
  assert.equal(a.ok, false); assert.equal(a.error.kind, 'rate_limited'); assert.equal(a.error.retryAfterMs, 7000);
  const b = await runProvider(mb, track('Shayad', 'Arijit Singh'), ctx);
  assert.equal(b.ok, false);
  const c = await runProvider(mb, track('Shayad', 'Arijit Singh'), ctx);
  assert.equal(c.skipped, true, 'breaker is open: no further calls');
  const callsBefore = h.calls.length;
  await runProvider(mb, track('Shayad', 'Arijit Singh'), ctx);
  assert.equal(h.calls.length, callsBefore);
});

/* --------------------------------------------------------------- Spotify */

const SP_ITEMS = { tracks: { items: [{ id: 'sp-1', name: 'Shayad', artists: [{ id: 'sa-1', name: 'Arijit Singh' }], duration_ms: 241000, album: { name: 'Love Aaj Kal', release_date: '2020-02-14' } }] } };
const spHandlers = ({ genres } = { genres: ['filmi', 'bollywood'] }) => [
  [(u) => u.includes('/api/token'), () => ({ access_token: 'tok', expires_in: 3600 })],
  [(u) => u.endsWith('/search'), () => SP_ITEMS],
  [(u) => u.endsWith('/artists/sa-1'), () => ({ id: 'sa-1', name: 'Arijit Singh', ...(genres ? { genres } : {}) })]
];

test('Spotify: client-credentials token, search limited to 10, genres as weak composition evidence', async () => {
  const h = fakeHttp(spHandlers());
  const r = await createSpotify({ limiter: createLimiter(0) }).lookup(track('Shayad', 'Arijit Singh'), ctxFor(h));
  const tokenCall = h.calls[0];
  assert.match(tokenCall.headers.Authorization, /^Basic /); assert.match(tokenCall.body, /grant_type=client_credentials/);
  const search = h.calls.find((c) => c.url.endsWith('/search'));
  assert.ok(search.params.limit <= 10, 'Dev-mode search cap'); assert.equal(search.headers.Authorization, 'Bearer tok'); assert.equal(search.params.type, 'track');
  assert.equal(r.meta.spotify_track_id, 'sp-1');
  assert.ok(keys(r).includes('genre:bollywood') && keys(r).includes('genre:film-music'));
  assert.ok(r.observations.filter((o) => o.key.startsWith('genre:')).every((o) => o.scope === 'composition' && o.p < 0.7), 'artist genres are weak and composition-level');
  assert.ok(!h.calls.some((c) => /audio-features|audio-analysis|recommendations/.test(c.url)), 'never calls the restricted endpoints');
});

test('Spotify: works when the deprecated artist `genres` field is missing', async () => {
  const h = fakeHttp(spHandlers({ genres: null }));
  const r = await createSpotify({ limiter: createLimiter(0) }).lookup(track('Shayad', 'Arijit Singh'), ctxFor(h));
  assert.equal(r.meta.spotify_track_id, 'sp-1'); assert.ok(!keys(r).some((k) => k.startsWith('genre:')));
});

test('Spotify: 401 refreshes the token once; 403 is a non-retryable "forbidden" that opens the breaker for long', async () => {
  let searchCalls = 0;
  const h = fakeHttp([
    [(u) => u.includes('/api/token'), () => ({ access_token: 'tok' + Math.random(), expires_in: 3600 })],
    [(u) => u.endsWith('/search'), () => { searchCalls++; if (searchCalls === 1) throw httpErr(401); return SP_ITEMS; }],
    [(u) => u.endsWith('/artists/sa-1'), () => ({ id: 'sa-1', genres: [] })]
  ]);
  const r = await createSpotify({ limiter: createLimiter(0) }).lookup(track('Shayad', 'Arijit Singh'), ctxFor(h));
  assert.equal(r.meta.spotify_track_id, 'sp-1');

  const h2 = fakeHttp([[(u) => u.includes('/api/token'), () => ({ access_token: 't', expires_in: 3600 })], [(u) => u.endsWith('/search'), () => { throw httpErr(403); }]]);
  const ctx = ctxFor(h2);
  const out = await runProvider(createSpotify({ limiter: createLimiter(0) }), track('Shayad', 'Arijit Singh'), ctx);
  assert.equal(out.error.kind, 'forbidden'); assert.equal(out.error.retryable, false);
  assert.ok(ctx.breaker.openUntil('spotify') - Date.now() >= 9 * 60 * 1000);
});

/* --------------------------------------------------------------- Last.fm */

test('Last.fm: weak, count-filtered, and composition-only for versioned titles', async () => {
  const mk = () => fakeHttp([[() => true, (u, o) => (o.params.method === 'track.getTopTags'
    ? { toptags: { tag: [{ name: 'bollywood', count: 100 }, { name: 'sad', count: 60 }, { name: 'hindi', count: 40 }, { name: 'obscure', count: 90 }, { name: 'romantic', count: 5 }] } }
    : { toptags: { tag: [{ name: 'pop', count: 100 }] } })]]);
  const plain = await createLastfm({ limiter: createLimiter(0) }).lookup(track('Shayad', 'Arijit Singh'), ctxFor(mk()));
  assert.deepEqual(keys(plain).filter((k) => k.startsWith('mood:')), ['mood:sad']);   // romantic (count 5) is under the threshold
  assert.ok(keys(plain).includes('genre:bollywood') && keys(plain).includes('language:hindi'));
  assert.ok(plain.observations.every((o) => o.p <= 0.6), 'never a strong source');

  const versioned = await createLastfm({ limiter: createLimiter(0) }).lookup(track('Shayad (Remix)', 'Arijit Singh'), ctxFor(mk()));
  assert.ok(!keys(versioned).some((k) => k.startsWith('mood:')), 'tags of the original do not describe a remix');
  assert.ok(keys(versioned).includes('genre:bollywood'));
});

test('Last.fm: API-level errors (HTTP 200 + error code) are classified; "not found" is a cacheable answer', async () => {
  const mk = (code) => fakeHttp([[() => true, () => ({ error: code, message: 'x' })]]);
  const rl = await runProvider(createLastfm({ limiter: createLimiter(0) }), track('A', 'B'), ctxFor(mk(29)));
  assert.equal(rl.error.kind, 'rate_limited');
  const bad = await runProvider(createLastfm({ limiter: createLimiter(0) }), track('A', 'B'), ctxFor(mk(10)));
  assert.equal(bad.error.kind, 'auth'); assert.equal(bad.error.retryable, false);
  const h = mk(6); const ctx = ctxFor(h);
  const nf = await createLastfm({ limiter: createLimiter(0) }).lookup(track('A', 'B'), ctx);
  assert.deepEqual(nf.observations, []); const n = h.calls.length;
  await createLastfm({ limiter: createLimiter(0) }).lookup(track('A', 'B'), ctx);
  assert.equal(h.calls.length, n, 'negative result cached');
});

/* ------------------------------------------------------------------- LLM */

test('LLM: maps only vocabulary names, caps confidence, ignores unknown songs, restricts versioned tracks', async () => {
  const picks = { genre: [{ name: 'Bollywood', confidence: 1 }, { name: 'Made Up Genre', confidence: 1 }], mood: [{ name: 'Romantic', confidence: 0.9 }], vocal: [{ name: 'Male Vocal', confidence: 0.9 }], language: [{ name: 'Hindi', confidence: 0.95 }], characteristic: [], context: [] };
  let seen;
  const ctx = ctxFor(null, {}, { llmClassify: async (a) => { seen = a; return { knownSong: true, picks }; } });
  const r = await createLlm().lookup(track('Shayad', 'Arijit Singh'), ctx);
  assert.deepEqual(keys(r), ['genre:bollywood', 'language:hindi', 'mood:romantic', 'vocal:male-vocal']);
  assert.ok(r.observations.every((o) => o.p <= 0.6));
  // genreTree is the static taxonomy hierarchy (the same for every track), not track data.
  assert.deepEqual(Object.keys(seen).sort(), ['album', 'artist', 'genreTree', 'title', 'vocab', 'year'], 'only text metadata is sent');
  assert.ok(!('audio' in seen));

  const v = await createLlm().lookup(track('Shayad (Reprise)', 'Arijit Singh'), ctxFor(null, {}, { llmClassify: async () => ({ knownSong: true, picks }) }));
  assert.deepEqual(keys(v), ['genre:bollywood', 'language:hindi']);

  const unknown = await createLlm().lookup(track('Zzz', 'Nobody'), ctxFor(null, {}, { llmClassify: async () => ({ knownSong: false, picks: {} }) }));
  assert.deepEqual(unknown.observations, []);
});

/* ----------------------------------------------------------------- Audio */

test('audio analysis is off unless enabled AND consented AND a URL is set', () => {
  assert.equal(isConfigured(load({ AUDIO_ANALYZER_URL: 'http://x' }), 'audio'), false);
  assert.equal(isConfigured(load({ AUDIO_ANALYZER_URL: 'http://x', AUDIO_ANALYSIS_ENABLED: 'true' }), 'audio'), false);
  assert.equal(isConfigured(load({ AUDIO_ANALYZER_URL: 'http://x', AUDIO_ANALYSIS_ENABLED: 'true', AUDIO_ANALYSIS_CONSENT: 'true' }), 'audio'), true);
});

test('audio adapter speaks the documented contract to a real HTTP server (stream link only, no credentials)', async () => {
  let received;
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received = { auth: req.headers.authorization, body: JSON.parse(body) };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ tempo: 96, energy: 0.4, danceability: 0.2, acousticness: 0.9, instrumentalness: 0.01, vocalPresence: 0.95, vocalGender: 'male',
        labels: [{ dimension: 'mood', name: 'Melancholic', score: 0.92 }, { dimension: 'mood', name: 'Romantic', score: 0.4 }, { dimension: 'genre', name: 'Bollywood', score: 0.9 }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/analyze`;
    const ctx = ctxFor(axios, { AUDIO_ANALYSIS_ENABLED: 'true', AUDIO_ANALYSIS_CONSENT: 'true', AUDIO_ANALYZER_URL: url, AUDIO_ANALYZER_TOKEN: 'secret-token' },
      { audioLink: async (id, ttl) => `https://backend.example/api/storage/stream/${id}?token=signed&ttl=${ttl}` });
    const r = await createAudio().lookup(track('Shayad', 'Arijit Singh'), ctx);
    assert.equal(received.auth, 'Bearer secret-token');
    assert.match(received.body.url, /\/api\/storage\/stream\/t1\?token=signed/); assert.equal(received.body.durationSeconds, 241);
    assert.ok(!JSON.stringify(received).includes('credentials') && !JSON.stringify(received.body).includes('accessToken'));
    assert.deepEqual(keys(r), ['characteristic:acoustic', 'genre:bollywood', 'mood:melancholic', 'vocal:male-vocal']);
    assert.ok(r.observations.every((o) => o.group === 'audio' && o.p <= 0.85));
    assert.equal(r.source.evidence.tempo, 96);
  } finally { server.close(); }
});

test('audio adapter: analyzer down or garbage output are provider errors, not crashes', async () => {
  const base = { AUDIO_ANALYSIS_ENABLED: 'true', AUDIO_ANALYSIS_CONSENT: 'true', AUDIO_ANALYZER_URL: 'http://analyzer' };
  const ctxDown = ctxFor(fakeHttp([[() => true, () => { throw httpErr(502); }]]), base, { audioLink: async () => 'u' });
  const a = await runProvider(createAudio(), track('S', 'A'), ctxDown);
  assert.equal(a.error.kind, 'unavailable');
  const ctxBad = ctxFor(fakeHttp([[() => true, () => 'not json']]), base, { audioLink: async () => 'u' });
  assert.equal((await runProvider(createAudio(), track('S', 'A'), ctxBad)).error.kind, 'bad_response');
});

test('secrets never appear in provider error messages', async () => {
  const h = fakeHttp([[() => true, () => { throw Object.assign(new Error('Request failed with Authorization: Bearer topsecret'), { response: { status: 500, headers: {} } }); }]]);
  const out = await runProvider(createLastfm({ limiter: createLimiter(0) }), track('A', 'B'), ctxFor(h));
  assert.ok(!out.error.message.includes('topsecret') && !out.error.message.includes('lfkey'));
});

test('a permanently unusable provider (bad/missing credentials) is not a reason to retry jobs; an outage is', async () => {
  const ctx = ctxFor(fakeHttp([]));
  const p = { name: 'x', lookup: async () => { throw new ProviderError('x', 'auth', 'rejected', { retryable: false }); } };
  const first = await runProvider(p, track('A', 'B'), ctx);
  assert.equal(first.error.retryable, false);
  const second = await runProvider(p, track('A', 'B'), ctx);            // breaker is open now
  assert.equal(second.skipped, true); assert.equal(second.error.retryable, false);
  const flaky = { name: 'y', lookup: async () => { throw new ProviderError('y', 'unavailable', 'down'); } };
  const ctx2 = ctxFor(fakeHttp([])); ctx2.breaker = createBreaker({ failures: 1, cooldownMs: 1000 });
  await runProvider(flaky, track('A', 'B'), ctx2);
  const paused = await runProvider(flaky, track('A', 'B'), ctx2);
  assert.equal(paused.skipped, true); assert.equal(paused.error.retryable, true);
});
