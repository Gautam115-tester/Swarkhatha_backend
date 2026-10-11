/**
 * Lyrics lookup, built for speed.
 *
 * Why the old flow took 10-15 s: the app called a free Hugging Face Space
 * (which sleeps and cold-starts) one URL at a time with a 12 s timeout each.
 *
 * What this does instead:
 *   1. Providers are RACED in parallel - the first one that returns synced
 *      (timestamped) lyrics wins; the slow one is hedged, not waited for.
 *   2. LRCLIB (fast, free, no key, returns standard LRC) is the primary.
 *      Lyrica (the old source) stays as a fallback for Hindi/regional songs
 *      LRCLIB does not have.
 *   3. Every result (including "not found") is cached by the route.
 */
const axios = require('axios');

const LRCLIB = process.env.LRCLIB_BASE_URL || 'https://lrclib.net/api';
const LYRICA_URLS = (process.env.LYRICA_BASE_URLS ||
  'https://wilooper-lyrica.hf.space,https://test-0k.onrender.com')
  .split(',').map((s) => s.trim()).filter(Boolean);

const UA = 'SwarKatha/2.0 (https://github.com/swarkatha)';
const PROVIDER_TIMEOUT_MS = Number(process.env.LYRICS_PROVIDER_TIMEOUT_MS || 4500);
const LYRICA_HEDGE_DELAY_MS = Number(process.env.LYRICS_LYRICA_DELAY_MS || 1200);
const PLAIN_WAIT_FOR_SYNCED_MS = 800;

/* ------------------------------ normalisation ------------------------------ */

function cleanTitle(raw) {
  let s = String(raw || '');
  s = s.replace(/\.(mp3|m4a|flac|wav|aac|ogg)$/i, '');
  s = s.replace(/\s*[\(\[\{][^\)\]\}]*[\)\]\}]\s*/g, ' '); // (From "Movie"), [Remix] ...
  s = s.replace(/\s*[-\u2013\u2014|]\s*(from|official|lyrical|lyric|video|audio|full song|remastered).*$/i, '');
  s = s.replace(/\b(feat|ft)\.?\s+.*$/i, '');
  return s.replace(/\s+/g, ' ').trim();
}

function firstArtist(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  return s.split(/\s*(?:,|&|;|\/|\bfeat\.?\b|\bft\.?\b|\band\b)\s*/i)[0].trim();
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function cacheKey(title, artist) {
  return `${norm(firstArtist(artist))}||${norm(cleanTitle(title))}`;
}

/* -------------------------------- LRC parser ------------------------------- */

/**
 * Parses LRC text into [{ text, start_time, end_time }] (milliseconds).
 * Handles multiple stamps per line, [mm:ss] / [mm:ss.xx] / [mm:ss.xxx],
 * and the [offset:+/-ms] tag. Metadata tags ([ar:], [ti:] ...) are ignored.
 */
function parseLrc(lrc) {
  if (!lrc || typeof lrc !== 'string') return [];
  let offset = 0;
  const raw = [];
  const stampRe = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  for (const line of lrc.split(/\r?\n/)) {
    const off = line.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/i);
    if (off) { offset = parseInt(off[1], 10) || 0; continue; }
    const stamps = [];
    let m;
    stampRe.lastIndex = 0;
    while ((m = stampRe.exec(line)) !== null) {
      const frac = m[3] ? parseInt(m[3].padEnd(3, '0').slice(0, 3), 10) : 0;
      stamps.push(parseInt(m[1], 10) * 60000 + parseInt(m[2], 10) * 1000 + frac);
    }
    if (!stamps.length) continue;
    const text = line.replace(/\[[^\]]*\]/g, '').trim();
    for (const t of stamps) raw.push({ text, start: Math.max(0, t - offset) });
  }
  raw.sort((a, b) => a.start - b.start);
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    if (!raw[i].text) continue; // instrumental gap: keep timing, drop the line
    const next = raw[i + 1];
    out.push({
      text: raw[i].text,
      start_time: raw[i].start,
      end_time: next ? next.start : raw[i].start + 5000,
    });
  }
  return out;
}

function toResult(source, { synced, plain }) {
  const timed = parseLrc(synced);
  const plainText = (plain && String(plain).trim()) ||
    (timed.length ? timed.map((l) => l.text).join('\n') : '');
  if (!timed.length && !plainText) return null;
  return { source, timed_lyrics: timed, plain_lyrics: plainText, synced: timed.length > 0 };
}

/* --------------------------------- providers -------------------------------- */

const http = axios.create({
  timeout: PROVIDER_TIMEOUT_MS,
  headers: { 'User-Agent': UA },
  validateStatus: (s) => s >= 200 && s < 300,
});

function pickBest(rows, { title, artist, duration }) {
  const wantT = norm(cleanTitle(title));
  const wantA = norm(firstArtist(artist));
  let best = null;
  let bestScore = -1;
  for (const r of rows || []) {
    if (!r || r.instrumental) continue;
    if (!r.syncedLyrics && !r.plainLyrics) continue;
    let score = 0;
    if (r.syncedLyrics) score += 100;
    const t = norm(cleanTitle(r.trackName));
    if (t === wantT) score += 40; else if (t.includes(wantT) || wantT.includes(t)) score += 15;
    const a = norm(r.artistName);
    if (wantA && (a.includes(wantA) || wantA.includes(a))) score += 30;
    if (duration && r.duration) {
      const d = Math.abs(Number(r.duration) - Number(duration));
      score += d <= 2 ? 25 : d <= 5 ? 12 : d > 20 ? -30 : 0;
    }
    if (score > bestScore) { bestScore = score; best = r; }
  }
  // Refuse weak matches so we never show the wrong song's lyrics.
  return bestScore >= 40 ? best : null;
}

async function lrclibSearch(params, ctx) {
  const { data } = await http.get(`${LRCLIB}/search`, { params });
  const best = pickBest(data, ctx);
  return best ? toResult('lrclib', { synced: best.syncedLyrics, plain: best.plainLyrics }) : null;
}

async function lrclibExact(ctx) {
  const params = { track_name: ctx.cleanT, artist_name: ctx.cleanA };
  if (ctx.duration) params.duration = Math.round(ctx.duration);
  const { data } = await http.get(`${LRCLIB}/get`, { params });
  if (!data || data.instrumental) return null;
  return toResult('lrclib', { synced: data.syncedLyrics, plain: data.plainLyrics });
}

async function lrclib(ctx) {
  const attempts = [];
  if (ctx.cleanA) attempts.push(lrclibExact(ctx).catch(() => null));
  attempts.push(
    lrclibSearch({ track_name: ctx.cleanT, ...(ctx.cleanA ? { artist_name: ctx.cleanA } : {}) }, ctx).catch(() => null)
  );
  const first = await firstGood(attempts);
  if (first) return first;
  // Looser last resort: free-text query.
  return lrclibSearch({ q: `${ctx.cleanT} ${ctx.cleanA}`.trim() }, ctx);
}

async function lyrica(ctx) {
  const params = { artist: ctx.cleanA || ctx.artist, song: ctx.cleanT, timestamps: 'true', fast: 'true' };
  const tries = LYRICA_URLS.map(async (base) => {
    const { data } = await http.get(`${base}/lyrics/`, { params });
    if (!data || data.status !== 'success' || !data.data) return null;
    const d = data.data;
    if (Array.isArray(d.timed_lyrics) && d.timed_lyrics.length) {
      const timed = d.timed_lyrics
        .map((l) => ({
          text: String(l.text || '').trim(),
          start_time: Math.round(Number(l.start_time) || 0),
          end_time: Math.round(Number(l.end_time) || Number(l.start_time) || 0),
        }))
        .filter((l) => l.text);
      if (timed.length) {
        return { source: 'lyrica', timed_lyrics: timed, synced: true,
                 plain_lyrics: String(d.plain_lyrics || d.lyrics || timed.map((l) => l.text).join('\n')) };
      }
    }
    const plain = d.plain_lyrics || d.lyrics;
    return plain && String(plain).trim() ? toResult('lyrica', { plain }) : null;
  });
  return firstGood(tries.map((p) => p.catch(() => null)));
}

/* ---------------------------------- racing --------------------------------- */

/** Resolves with the first non-null promise result; null if all are null. */
function firstGood(promises) {
  return new Promise((resolve) => {
    let pending = promises.length;
    if (!pending) return resolve(null);
    for (const p of promises) {
      Promise.resolve(p).then((v) => {
        if (v) resolve(v);
        else if (--pending === 0) resolve(null);
      }, () => { if (--pending === 0) resolve(null); });
    }
  });
}

/**
 * Race all providers. Synced lyrics win immediately; plain-only lyrics are
 * held for a short window in case a synced version is about to arrive.
 */
function raceProviders(runners) {
  return new Promise((resolve) => {
    let pending = runners.length;
    let plainHold = null;
    let plainTimer = null;
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(plainTimer);
      resolve(v);
    };
    const settle = () => {
      if (--pending === 0) finish(plainHold);
    };
    for (const run of runners) {
      run.start().then((r) => {
        if (done) return;
        if (r && r.synced) return finish(r);
        if (r && !plainHold) {
          plainHold = r;
          plainTimer = setTimeout(() => finish(plainHold), PLAIN_WAIT_FOR_SYNCED_MS);
        }
        settle();
      }, settle);
    }
    if (!pending) finish(null);
  });
}

async function findLyrics({ title, artist, duration }) {
  const ctx = {
    title, artist,
    duration: Number(duration) > 0 ? Number(duration) : null,
    cleanT: cleanTitle(title),
    cleanA: firstArtist(artist),
  };
  if (!ctx.cleanT) return null;

  // LRCLIB starts now; Lyrica starts after a short hedge delay (or at once if
  // LRCLIB already came back empty) so the common case costs one request.
  let lrclibEmpty;
  const lrclibDone = new Promise((r) => { lrclibEmpty = r; });
  const runners = [
    { start: () => lrclib(ctx).catch(() => null).then((r) => { if (!r) lrclibEmpty(); return r; }) },
    {
      start: () => Promise.race([
        new Promise((r) => setTimeout(r, LYRICA_HEDGE_DELAY_MS)),
        lrclibDone,
      ]).then(() => lyrica(ctx)),
    },
  ];
  return raceProviders(runners);
}

module.exports = { findLyrics, parseLrc, cleanTitle, firstArtist, cacheKey, pickBest };
