/**
 * In-memory LRU byte cache for cover-image responses ONLY (album
 * artwork / story thumbnails). NEVER used for audio or video bytes —
 * those are piped straight through in routes/storage.js proxyMedia()
 * and never touch this module.
 *
 * Cover art is small (resized to <=1000px, JPEG quality 82 — see
 * lib/coverImageStorage.js — so almost always well under 200KB) and,
 * once uploaded, never changes: a fresh filename + hash is minted on
 * every upload, nothing is ever overwritten in place. That makes it a
 * perfect fit for a bounded in-process cache — the same relatively small
 * set of album/story covers gets requested over and over by thousands of
 * different users/devices, and keeping the hot set in memory means those
 * repeat requests never pay for a Supabase lookup + Drime auth call +
 * Drime download round trip.
 *
 * This is a *complement* to edge/CDN caching (see /cdn-worker), not a
 * replacement for it.
 *
 * --- Memory-safety design (this is the part that keeps a 10,000-user
 * instance from OOM-crashing under load) ---
 *   - Hard cap: MAX_BYTES (default 50MB), enforced by evicting the
 *     least-recently-used entries whenever a new entry would push the
 *     running total over the cap. The cache can never grow past this
 *     ceiling no matter how many distinct images or how much traffic
 *     the instance sees — memory use here is O(cap), not O(users) or
 *     O(requests).
 *   - Single-item guard: if one image's bytes alone exceed MAX_BYTES,
 *     it is served to the caller but deliberately NOT stored. Without
 *     this check, inserting it would evict every other entry trying
 *     (and failing) to make room, wiping out a warm cache for an item
 *     that can't fit anyway.
 *   - Size is measured with the actual Buffer length (real resident
 *     bytes), not an item count or an estimate, so the cap reflects
 *     real memory pressure regardless of how image sizes vary.
 *   - Eviction always decrements the running byte total in the same
 *     step the entry is removed, so `currentBytes` can never drift
 *     from what's actually held in `store` (the #1 cause of a "leak"
 *     in a hand-rolled cache).
 *   - Concurrency: Node is single-threaded, so there's no data race on
 *     the Map itself, but many requests for the same not-yet-cached
 *     image can still arrive in the same tick (e.g. a newly-published
 *     album opened by hundreds of users in the same few seconds). The
 *     in-flight promise map below coalesces those into ONE upstream
 *     Drime fetch instead of one per request — without it, 10,000
 *     concurrent users cold-hitting one image would mean 10,000
 *     parallel Drime downloads (and 10,000x the memory momentarily
 *     held in flight), which is its own crash risk independent of the
 *     steady-state cache size.
 */

const MAX_BYTES = Number(process.env.COVER_IMAGE_CACHE_MAX_BYTES || 50 * 1024 * 1024); // 50MB default, strict cap

const store = new Map(); // key -> { buffer, contentType, size }
let currentBytes = 0;

const stat = { hits: 0, misses: 0, evictions: 0, oversizedSkips: 0 };

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

function evictOldest() {
  const oldestKey = store.keys().next().value;
  const oldest = store.get(oldestKey);
  store.delete(oldestKey);
  currentBytes -= oldest.size;
  stat.evictions++;
}

function set(key, entry) {
  // Guard: a single item larger than the whole budget is never cached —
  // caching it would mean evicting everything else just to immediately
  // evict this one too (see module comment above).
  if (entry.size > MAX_BYTES) {
    stat.oversizedSkips++;
    return;
  }

  if (store.has(key)) {
    currentBytes -= store.get(key).size;
    store.delete(key);
  }
  store.set(key, entry);
  currentBytes += entry.size;

  while (currentBytes > MAX_BYTES && store.size > 0) {
    evictOldest();
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
  if (cached) {
    stat.hits++;
    return cached;
  }

  stat.misses++; // every call that isn't an instant hit counts, even ones coalesced below
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

function invalidate(key) {
  const entry = store.get(key);
  if (!entry) return;
  store.delete(key);
  currentBytes -= entry.size;
}

function stats() {
  return {
    entries: store.size,
    bytes: currentBytes,
    maxBytes: MAX_BYTES,
    hits: stat.hits,
    misses: stat.misses,
    evictions: stat.evictions,
    oversizedSkips: stat.oversizedSkips
  };
}

module.exports = { getOrFetch, invalidate, stats };
