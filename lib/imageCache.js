/**
 * In-memory LRU byte cache for cover-image responses.
 *
 * Cover art is small (resized to <=1000px, JPEG quality 82 — see
 * lib/coverImageStorage.js — so almost always well under 200KB) and,
 * once uploaded, never changes: a fresh filename + hash is minted on
 * every upload, nothing is ever overwritten in place. That makes it a
 * perfect fit for a bounded in-process cache — the same relatively small
 * set of album/story covers gets requested over and over by thousands of
 * different users/devices, and keeping the hot set in memory means those
 * repeat requests never pay for a Supabase lookup + Drime auth call +
 * Drime download round trip (previously: EVERY cover image load, from
 * EVERY user, paid that full cost — see routes/storage.js GET
 * /cover/:accountId/:hash history).
 *
 * This is a *complement* to edge/CDN caching (see /cdn-worker), not a
 * replacement for it — it's what protects Render + Drime even before an
 * edge cache is in front of this service, and it's what serves any
 * request that reaches this instance despite CDN caching (cold cache,
 * CDN not set up yet, a client that bypasses it, etc).
 *
 * Deliberately NOT used for /stream or /file (audio) — those can be
 * hundreds of MB, and are piped straight through in routes/storage.js.
 * Buffering those in memory would fight the low-memory budget a free-tier
 * instance actually needs for this cache to be worth anything.
 */

const MAX_BYTES = Number(process.env.IMAGE_CACHE_MAX_BYTES || 200 * 1024 * 1024); // 200MB default

const store = new Map(); // key -> { buffer, contentType, size }
let currentBytes = 0;

// A Map in V8 preserves insertion order, so re-inserting an entry on
// every read is enough to implement "most recently used goes last,
// least recently used sits at the front" without a separate linked list.
function touch(key) {
  const entry = store.get(key);
  if (!entry) return undefined;
  store.delete(key);
  store.set(key, entry);
  return entry;
}

function set(key, entry) {
  if (store.has(key)) {
    currentBytes -= store.get(key).size;
    store.delete(key);
  }
  store.set(key, entry);
  currentBytes += entry.size;

  while (currentBytes > MAX_BYTES && store.size > 0) {
    const oldestKey = store.keys().next().value;
    const oldest = store.get(oldestKey);
    store.delete(oldestKey);
    currentBytes -= oldest.size;
  }
}

// Coalesces concurrent cache misses for the same key into a single
// upstream fetch — e.g. a newly-published episode/album that many users
// open in the same few seconds shouldn't turn into that many parallel
// Drime calls (and that many redundant Supabase-account lookups) for one
// image.
const inFlight = new Map(); // key -> Promise

async function getOrFetch(key, fetcher) {
  const cached = touch(key);
  if (cached) return cached;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const entry = await fetcher();
      set(key, entry);
      return entry;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, promise);
  return promise;
}

function stats() {
  return { entries: store.size, bytes: currentBytes, maxBytes: MAX_BYTES };
}

module.exports = { getOrFetch, stats };
