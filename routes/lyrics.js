const express = require('express');
const supabase = require('../lib/supabaseClient');
const { requireAuth } = require('../middleware/auth');
const { lyricsLimiter } = require('../middleware/rateLimit');
const { findLyrics, cacheKey } = require('../lib/lyricsProviders');

const router = express.Router();

/* Two cache layers so only the FIRST listener of a song ever waits on a
 * third-party lyrics API:
 *   1. in-memory LRU (instant, lost on Render restart / sleep)
 *   2. Supabase `lyrics_cache` table (durable, ~50 ms) - optional: if the
 *      table has not been created yet, everything still works, just without
 *      the durable layer. See supabase/migration_lyrics_cache.sql.
 */
const HIT_TTL_MS = 30 * 24 * 3600 * 1000;
const MISS_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 3000;
const mem = new Map();       // key -> { value|null, exp }
const inflight = new Map();  // key -> Promise  (dedupes concurrent requests)
let dbDisabled = false;

function memGet(key) {
  const e = mem.get(key);
  if (!e) return undefined;
  if (e.exp < Date.now()) { mem.delete(key); return undefined; }
  mem.delete(key); mem.set(key, e); // refresh LRU position
  return e.value;
}
function memSet(key, value) {
  mem.delete(key);
  mem.set(key, { value, exp: Date.now() + (value ? HIT_TTL_MS : MISS_TTL_MS) });
  if (mem.size > MAX_ENTRIES) mem.delete(mem.keys().next().value);
}

async function dbGet(key) {
  if (dbDisabled) return null;
  try {
    const { data, error } = await supabase
      .from('lyrics_cache').select('payload').eq('key', key).maybeSingle();
    if (error) {
      if (/relation .* does not exist|schema cache/i.test(error.message || '')) dbDisabled = true;
      return null;
    }
    return data ? data.payload : null;
  } catch (_) { return null; }
}

function dbSet(key, title, artist, value) {
  if (dbDisabled) return;
  supabase.from('lyrics_cache')
    .upsert({ key, title, artist, source: value.source, synced: value.synced, payload: value })
    .then(({ error }) => {
      if (error && /relation .* does not exist|schema cache/i.test(error.message || '')) dbDisabled = true;
    }, () => {});
}

async function lookup(key, { title, artist, duration }) {
  const cached = memGet(key);
  if (cached !== undefined) return { value: cached, cached: true };

  const stored = await dbGet(key);
  if (stored) { memSet(key, stored); return { value: stored, cached: true }; }

  if (!inflight.has(key)) {
    inflight.set(key, (async () => {
      try {
        const found = await findLyrics({ title, artist, duration });
        memSet(key, found || null);
        if (found) dbSet(key, title, artist, found);
        return found || null;
      } finally {
        inflight.delete(key);
      }
    })());
  }
  return { value: await inflight.get(key), cached: false };
}

// GET /api/lyrics?title=...&artist=...&duration=SECONDS
router.get('/', requireAuth, lyricsLimiter, async (req, res) => {
  const title = String(req.query.title || '').trim();
  const artist = String(req.query.artist || '').trim();
  const duration = Number(req.query.duration) || null;
  if (!title) return res.status(400).json({ error: 'title is required' });

  try {
    const key = cacheKey(title, artist);
    const { value, cached } = await lookup(key, { title, artist, duration });
    // Lyrics never change: let the phone and any proxy keep them for a day.
    res.set('Cache-Control', 'private, max-age=86400');
    if (!value) return res.json({ status: 'not_found' });
    res.json({ status: 'success', data: { ...value, cached } });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Lyrics lookup failed' });
  }
});

module.exports = router;
