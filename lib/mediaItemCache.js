/**
 * In-memory LRU cache for `media_items` LOOKUP METADATA — never audio or
 * video bytes.
 *
 * routes/storage.js looks up a media_items row by id on every single
 * stream-url request, download-url request, and every /stream and /file
 * proxy request (the last two happen on every seek/scrub too, since
 * range requests re-hit the same route). At 10,000 users that's a
 * Supabase round trip on nearly every play action, for a row that only
 * changes on upload, delete, or an admin cover-art edit — all rare
 * relative to playback traffic. Caching the tiny bit of metadata each of
 * those call sites actually needs removes that round trip for the
 * common case.
 *
 * Only a lightweight projection of the row is cached (id, type, title,
 * storage_hash, storage_account_id, storage_file_id, storage_path,
 * cover_image_url, duration_seconds, file_size_bytes) — never the full
 * row, and never the underlying audio/video file itself (that's
 * streamed straight through from Drime in proxyMedia(), see
 * routes/storage.js).
 *
 * --- Memory-safety design ---
 *   - Hard cap: MAX_BYTES (default 10MB). Entry size is measured with
 *     Buffer.byteLength(JSON.stringify(entry), 'utf8') — an approximate
 *     but honest measure of the real bytes an entry costs — rather than
 *     limiting by item count, so the cap holds even if some catalog rows
 *     end up with much longer titles/paths than others.
 *   - LRU eviction identical in shape to lib/coverImageCache.js: a Map's
 *     insertion order gives "oldest first" for free.
 *   - 6-hour TTL on top of LRU, used the way large streaming platforms
 *     actually do this: as a distant backstop, not the primary
 *     staleness guard. The two write paths that can change a cached
 *     row post-upload — deleting an item, and an admin re-covering an
 *     album/story (which propagates cover_image_url onto every
 *     existing track/episode in bulk — see routes/media.js) — both
 *     call invalidate() explicitly for every affected id the moment
 *     the write happens, so correctness doesn't depend on the TTL at
 *     all for the cases that are actually expected to occur. The TTL
 *     is only there to bound staleness for anything unanticipated
 *     (e.g. a direct DB edit outside this app), and 6 hours is
 *     deliberately generous given this row is read on every
 *     seek/scrub during playback — a short TTL would mean
 *     re-querying Supabase mid-session for a long audio-story episode
 *     for no correctness benefit, since real edits already invalidate
 *     themselves immediately.
 *   - Expired entries are removed both lazily (checked on read) and
 *     proactively (a background sweep every TTL_MS, unref()'d so it
 *     never keeps the Node process alive on its own) — so `bytes` and
 *     `entries` in stats() reflect reality even for ids nobody has
 *     re-requested since expiring.
 *   - Only successful lookups are cached — a 404/not-found id is never
 *     stored, so it can't be mistaken for a real cached "miss" or block
 *     the id from resolving once it does exist.
 *   - Concurrency: an in-flight promise map coalesces simultaneous
 *     requests for the same not-yet-cached id (e.g. many listeners
 *     opening the same track at once) into a single Supabase query,
 *     the same technique used in lib/coverImageCache.js.
 */

const TTL_MS = Number(process.env.MEDIA_ITEM_CACHE_TTL_MS || 6 * 60 * 60 * 1000); // 6 hours
const MAX_BYTES = Number(process.env.MEDIA_ITEM_CACHE_MAX_BYTES || 10 * 1024 * 1024); // 10MB default, strict cap

const store = new Map(); // key -> { value, size, expiresAt }
let currentBytes = 0;

const stat = { hits: 0, misses: 0, evictions: 0, expirations: 0 };

// Lightweight projection — only what stream-url, download-url, and the
// stream/file proxy in routes/storage.js actually read off a media_items
// row. Keeps entries small (and honest about what's "lightweight
// metadata") and avoids caching columns that don't matter for serving
// playback, like uploaded_by or created_at.
function project(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    storage_hash: row.storage_hash,
    storage_account_id: row.storage_account_id,
    storage_file_id: row.storage_file_id,
    storage_path: row.storage_path,
    cover_image_url: row.cover_image_url,
    duration_seconds: row.duration_seconds,
    file_size_bytes: row.file_size_bytes
  };
}

function sizeOf(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function touch(key) {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    store.delete(key);
    currentBytes -= entry.size;
    stat.expirations++;
    return undefined;
  }
  store.delete(key);
  store.set(key, entry); // re-insert => most-recently-used
  return entry;
}

function evictOldest() {
  const oldestKey = store.keys().next().value;
  const oldest = store.get(oldestKey);
  store.delete(oldestKey);
  currentBytes -= oldest.size;
  stat.evictions++;
}

function set(key, value) {
  const size = sizeOf(value);

  // A single entry bigger than the whole budget is never cached — same
  // reasoning as lib/coverImageCache.js's oversized guard. In practice
  // this should never trigger for media_items metadata, but it keeps
  // the cache from ever pointlessly evicting itself empty.
  if (size > MAX_BYTES) return;

  if (store.has(key)) {
    currentBytes -= store.get(key).size;
    store.delete(key);
  }
  store.set(key, { value, size, expiresAt: Date.now() + TTL_MS });
  currentBytes += size;

  while (currentBytes > MAX_BYTES && store.size > 0) {
    evictOldest();
  }
}

// Coalesces concurrent cache misses for the same id into a single
// Supabase query — see module comment.
const inFlight = new Map(); // key -> Promise

async function getOrFetch(key, fetcher) {
  const cached = touch(key);
  if (cached) {
    stat.hits++;
    return cached.value;
  }

  stat.misses++; // every call that isn't an instant hit counts, even ones coalesced below
  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const row = await fetcher();
      if (!row) return null; // cache only successful lookups
      const value = project(row);
      set(key, value);
      return value;
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

function sweepExpired() {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) {
      store.delete(key);
      currentBytes -= entry.size;
      stat.expirations++;
    }
  }
}

// Proactive sweep so stats (and real memory) stay accurate for entries
// nobody re-requests after they expire. unref() so this timer alone
// never keeps the process running (matters for graceful shutdown/tests).
const sweepTimer = setInterval(sweepExpired, TTL_MS);
if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

function stats() {
  return {
    entries: store.size,
    bytes: currentBytes,
    maxBytes: MAX_BYTES,
    ttlMs: TTL_MS,
    hits: stat.hits,
    misses: stat.misses,
    evictions: stat.evictions,
    expirations: stat.expirations
  };
}

module.exports = { getOrFetch, invalidate, stats };
