'use strict';

/**
 * Centralized artwork management.
 *
 *   ONE ALBUM  = ONE IMAGE = every track shares it.
 *   ONE SERIES = ONE IMAGE = every episode shares it.
 *
 * The albums / story_series rows are the ONLY owners of artwork
 * (cover_image_url + image_storage_account_id/file_id/hash). Tracks and episodes
 * reach it through album_id / story_series_id.
 *
 * Why this lives on the server and not in the admin app
 * -----------------------------------------------------
 * The admin app used to upload a cover to Drime BEFORE asking the backend whether
 * the album already had one, so every track (single upload) or every session
 * (batch upload) pushed another copy of the same picture to Drime that the backend
 * then silently ignored. The decision "does this album already have artwork?" can
 * only be made safely next to the data, under a lock:
 *
 *   - identity: albums = (normalized name, release year); series = normalized title
 *   - find-or-create is serialized per identity (in-process lock) AND backed by a
 *     unique index (migration_centralized_artwork.sql) for multi-instance safety
 *   - artwork upload is serialized per album/series; the check "does it already
 *     have artwork?" and the Drime upload happen inside the same lock, so N
 *     simultaneous track uploads of one album produce exactly one Drime file
 *   - the database write is a compare-and-set (`cover_image_url is null`); if
 *     another instance won the race, the just-uploaded file is deleted again
 *
 * Dependencies are injectable so the whole thing is testable without Supabase,
 * sharp or Drime (see test/artwork.test.js).
 */

/* ---------------------------------------------------------------- helpers */

// Strips underscores and filename-unsafe characters, collapses whitespace.
// (Moved here from routes/media.js so identity keys and stored names agree.)
function sanitizeSegment(value) {
  return String(value || '')
    .replace(/_/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

// Must match the generated columns albums.name_key / story_series.title_key:
//   lower(regexp_replace(btrim(x), '\s+', ' ', 'g'))
function normalizeKey(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Accepts 2020, "2020", "2020-02-14", "14/02/2020", Date. Returns null when no
// plausible year is present (never guesses).
function parseReleaseYear(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) value = value.getUTCFullYear();
  const m = String(value).match(/(?<!\d)(19\d{2}|20\d{2}|21\d{2})(?!\d)/);
  if (!m) return null;
  const year = Number(m[1]);
  const max = new Date().getUTCFullYear() + 1;
  return year >= 1900 && year <= max ? year : null;
}

// Tiny keyed async mutex: callers with the same key run one at a time, in order.
const _locks = new Map();
async function withLock(key, fn) {
  const prev = _locks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = prev.then(() => gate);
  _locks.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (_locks.get(key) === tail) _locks.delete(key);
  }
}

const PAGE_SIZE = 1000;
async function fetchAll(buildQuery) {
  let all = [];
  let from = 0;
  while (true) {
    const { data, error } = await buildQuery().range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    all = all.concat(data || []);
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

/* ---------------------------------------------------------------- service */

function createArtworkService(deps = {}) {
  const db = deps.supabase || require('./supabaseClient');
  const storage = deps.coverStorage || require('./coverImageStorage');
  const invalidateMediaItem = deps.invalidateMediaItem || ((id) => require('./mediaItemCache').invalidate(id));
  const parentTtlMs = deps.parentTtlMs ?? 30 * 1000;
  const log = deps.log || ((...a) => console.error(...a));

  /* ---- parent (album/series) artwork lookup used on every catalog read ---- */
  let parents = null; // { at, albums: Map, series: Map }
  let parentsLoading = null;

  function invalidateParents() { parents = null; }

  async function loadParents() {
    if (parents && Date.now() - parents.at < parentTtlMs) return parents;
    if (parentsLoading) return parentsLoading;
    parentsLoading = (async () => {
      try {
        const [albums, series] = await Promise.all([
          fetchAll(() => db.from('albums').select('id, name, release_year, cover_image_url').order('id')),
          fetchAll(() => db.from('story_series').select('id, title, cover_image_url').order('id'))
        ]);
        parents = {
          at: Date.now(),
          albums: new Map(albums.map((a) => [a.id, a])),
          series: new Map(series.map((s) => [s.id, s]))
        };
        return parents;
      } finally {
        parentsLoading = null;
      }
    })();
    return parentsLoading;
  }

  // Resolve artwork for media_items rows THROUGH their parent. A track's own
  // cover_image_url column is only a legacy mirror; the parent always wins, so a
  // stale or missing mirror can never show a different (or no) image.
  async function applyArtwork(items) {
    if (!items || items.length === 0) return items;
    const p = await loadParents();
    return items.map((m) => {
      if (m.album_id && p.albums.has(m.album_id)) {
        const a = p.albums.get(m.album_id);
        return { ...m, cover_image_url: a.cover_image_url || m.cover_image_url || null, release_year: a.release_year ?? null };
      }
      if (m.story_series_id && p.series.has(m.story_series_id)) {
        const s = p.series.get(m.story_series_id);
        return { ...m, cover_image_url: s.cover_image_url || m.cover_image_url || null };
      }
      return m;
    });
  }

  async function artworkForSeriesKey(titles) {
    const p = await loadParents();
    const byKey = new Map();
    for (const s of p.series.values()) byKey.set(normalizeKey(s.title), s);
    return titles.map((t) => byKey.get(normalizeKey(t))?.cover_image_url || null);
  }

  /* ---- row access ---- */

  async function getAlbum(id) {
    const { data, error } = await db.from('albums').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  }

  async function getSeries(id) {
    const { data, error } = await db.from('story_series').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  }

  async function findAlbum(nameKey, year) {
    let q = db.from('albums').select('*').eq('name_key', nameKey);
    q = year == null ? q.is('release_year', null) : q.eq('release_year', year);
    // If legacy duplicates still exist (before consolidate-artwork.js has run),
    // deterministically prefer the biggest, then oldest, row instead of erroring.
    const { data, error } = await q
      .order('track_count', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(1);
    if (error) throw new Error(error.message);
    return (data && data[0]) || null;
  }

  async function findSeries(titleKey) {
    const { data, error } = await db.from('story_series').select('*')
      .eq('title_key', titleKey)
      .order('episode_count', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(1);
    if (error) throw new Error(error.message);
    return (data && data[0]) || null;
  }

  /* ---- find-or-create (identity) ---- */

  // Album identity = (normalized name, release year). Same name + different year
  // are DIFFERENT albums. Same name + same year reuse the one album (and its one
  // artwork) regardless of which artist credit a track carries.
  async function ensureAlbum({ name, artist, releaseYear }) {
    const albumName = sanitizeSegment(name) || 'Unknown Album';
    const albumArtist = artist ? sanitizeSegment(artist) || null : null;
    const year = parseReleaseYear(releaseYear);
    const key = normalizeKey(albumName);

    return withLock(`album:${key}|${year ?? ''}`, async () => {
      const existing = await findAlbum(key, year);
      if (existing) {
        if (!existing.artist && albumArtist) {
          const { data } = await db.from('albums').update({ artist: albumArtist }).eq('id', existing.id).select().single();
          invalidateParents();
          return data || existing;
        }
        return existing;
      }
      const { data, error } = await db.from('albums')
        .insert({ name: albumName, artist: albumArtist, release_year: year, track_count: 0 })
        .select().single();
      if (error) {
        // Lost a race against another backend instance: the unique index fired.
        if (error.code === '23505') {
          const again = await findAlbum(key, year);
          if (again) return again;
        }
        throw new Error(error.message);
      }
      invalidateParents();
      return data;
    });
  }

  // Series identity = normalized title (the text before " Ep ").
  async function ensureSeries({ title, narrator }) {
    const seriesTitle = sanitizeSegment(title);
    if (!seriesTitle) throw new Error('Series title is required');
    const key = normalizeKey(seriesTitle);

    return withLock(`series:${key}`, async () => {
      const existing = await findSeries(key);
      if (existing) {
        if (!existing.narrator && narrator) {
          const { data } = await db.from('story_series').update({ narrator }).eq('id', existing.id).select().single();
          return data || existing;
        }
        return existing;
      }
      const { data, error } = await db.from('story_series')
        .insert({ title: seriesTitle, narrator: narrator || null, episode_count: 0 })
        .select().single();
      if (error) {
        if (error.code === '23505') {
          const again = await findSeries(key);
          if (again) return again;
        }
        throw new Error(error.message);
      }
      invalidateParents();
      return data;
    });
  }

  /* ---- counters (recomputed, never read-modify-write) ---- */

  async function recountAlbum(albumId) {
    const { count, error } = await db.from('media_items').select('id', { count: 'exact', head: true }).eq('album_id', albumId);
    if (error) throw new Error(error.message);
    await db.from('albums').update({ track_count: count ?? 0 }).eq('id', albumId);
    invalidateParents();
    return count ?? 0;
  }

  async function recountSeries(seriesId) {
    const { count, error } = await db.from('media_items').select('id', { count: 'exact', head: true }).eq('story_series_id', seriesId);
    if (error) throw new Error(error.message);
    await db.from('story_series').update({ episode_count: count ?? 0 }).eq('id', seriesId);
    invalidateParents();
    return count ?? 0;
  }

  /* ---- Drime file bookkeeping ---- */

  // True if ANY album or series row still points at this Drime file.
  async function isImageReferenced(storageFileId) {
    if (!storageFileId) return false;
    const [a, s] = await Promise.all([
      db.from('albums').select('id', { count: 'exact', head: true }).eq('image_storage_file_id', storageFileId),
      db.from('story_series').select('id', { count: 'exact', head: true }).eq('image_storage_file_id', storageFileId)
    ]);
    if (a.error) throw new Error(a.error.message);
    if (s.error) throw new Error(s.error.message);
    return (a.count || 0) + (s.count || 0) > 0;
  }

  // Delete an image file only after verifying nothing references it any more.
  // Best-effort by design: never fails the request that triggered it.
  async function deleteImageIfUnreferenced({ accountId, storageFileId }) {
    if (!accountId || !storageFileId) return false;
    try {
      if (await isImageReferenced(storageFileId)) return false;
      await storage.deleteImage({ accountId, storageFileId });
      return true;
    } catch (e) {
      log('[artwork] failed to delete unreferenced image (continuing):', e.response?.data?.message || e.message);
      return false;
    }
  }

  async function mirrorToItems(column, parentId, url) {
    const { data, error } = await db.from('media_items')
      .update({ cover_image_url: url }).eq(column, parentId).select('id');
    if (error) { log('[artwork] mirror to items failed (continuing):', error.message); return; }
    // Bulk updates bypass the single-id invalidation in mediaItemCache.
    (data || []).forEach((row) => invalidateMediaItem(row.id));
  }

  /* ---- album artwork: first writer wins, exactly one Drime upload ---- */

  // `buffer` is only uploaded if the album STILL has no artwork once we hold the
  // lock. Otherwise the bytes are discarded and nothing touches Drime.
  async function setAlbumArtworkIfMissing({ albumId, buffer, urlFor }) {
    return withLock(`albumart:${albumId}`, async () => {
      const album = await getAlbum(albumId);
      if (!album) return { album: null, uploaded: false };
      if (album.cover_image_url) return { album, uploaded: false };
      if (!buffer || !buffer.length) return { album, uploaded: false };

      const up = await storage.uploadImage({ buffer, prefix: 'album' });
      const url = urlFor(up);
      const { data: updated, error } = await db.from('albums')
        .update({
          cover_image_url: url,
          image_storage_account_id: up.accountId,
          image_storage_file_id: up.storageFileId,
          image_storage_hash: up.storageHash
        })
        .eq('id', albumId)
        .is('cover_image_url', null) // compare-and-set: protects against another instance
        .select();

      if (error || !updated || updated.length === 0) {
        // Lost the race (or the write failed): never leave our file orphaned.
        await deleteImageIfUnreferenced({ accountId: up.accountId, storageFileId: up.storageFileId });
        if (error) throw new Error(error.message);
        return { album: await getAlbum(albumId), uploaded: false };
      }

      invalidateParents();
      await mirrorToItems('album_id', albumId, url);
      return { album: updated[0], uploaded: true };
    });
  }

  /* ---- series artwork: admin-managed, replaces the single image ---- */

  async function setSeriesArtwork({ seriesId, buffer, urlFor }) {
    return withLock(`seriesart:${seriesId}`, async () => {
      const series = await getSeries(seriesId);
      if (!series) return { series: null, uploaded: false };
      if (!buffer || !buffer.length) return { series, uploaded: false };

      const up = await storage.uploadImage({ buffer, prefix: 'story' });
      const url = urlFor(up);
      const { data: updated, error } = await db.from('story_series')
        .update({
          cover_image_url: url,
          image_storage_account_id: up.accountId,
          image_storage_file_id: up.storageFileId,
          image_storage_hash: up.storageHash
        })
        .eq('id', seriesId)
        .select();
      if (error || !updated || updated.length === 0) {
        await deleteImageIfUnreferenced({ accountId: up.accountId, storageFileId: up.storageFileId });
        throw new Error(error ? error.message : 'Series disappeared during artwork upload');
      }

      invalidateParents();
      await mirrorToItems('story_series_id', seriesId, url);

      // The row now points at the new file, so the previous one is only deleted
      // after the swap succeeded AND after verifying nothing else references it.
      if (series.image_storage_file_id && series.image_storage_file_id !== up.storageFileId) {
        await deleteImageIfUnreferenced({
          accountId: series.image_storage_account_id,
          storageFileId: series.image_storage_file_id
        });
      }
      return { series: updated[0], uploaded: true };
    });
  }

  // Back-compat for clients that still upload first and register after
  // (POST /api/media with coverImageUrl + cover* ids). Repoints the series at an
  // already-uploaded file; deletes the previous file only if now unreferenced.
  async function setSeriesArtworkFromUploaded({ seriesId, url, accountId, storageFileId, storageHash }) {
    return withLock(`seriesart:${seriesId}`, async () => {
      const series = await getSeries(seriesId);
      if (!series) return null;
      if (series.cover_image_url === url) return series;
      const { data: updated, error } = await db.from('story_series')
        .update({
          cover_image_url: url,
          image_storage_account_id: accountId || null,
          image_storage_file_id: storageFileId || null,
          image_storage_hash: storageHash || null
        })
        .eq('id', seriesId).select();
      if (error) throw new Error(error.message);
      invalidateParents();
      await mirrorToItems('story_series_id', seriesId, url);
      if (series.image_storage_file_id && series.image_storage_file_id !== storageFileId) {
        await deleteImageIfUnreferenced({
          accountId: series.image_storage_account_id,
          storageFileId: series.image_storage_file_id
        });
      }
      return (updated && updated[0]) || series;
    });
  }

  // Back-compat for old admin builds that upload a cover for EVERY track: the
  // album already has artwork, so the freshly uploaded duplicate is deleted
  // (only if nothing references it).
  async function discardRedundantUpload({ accountId, storageFileId }) {
    return deleteImageIfUnreferenced({ accountId, storageFileId });
  }

  // Back-compat: the album has no artwork yet and an old client sent an
  // already-uploaded file with the first track. Adopt it (first writer wins).
  async function adoptAlbumArtworkIfMissing({ albumId, url, accountId, storageFileId, storageHash }) {
    return withLock(`albumart:${albumId}`, async () => {
      const album = await getAlbum(albumId);
      if (!album) return { album: null, adopted: false };
      if (album.cover_image_url || !url) return { album, adopted: false };
      const { data: updated, error } = await db.from('albums')
        .update({
          cover_image_url: url,
          image_storage_account_id: accountId || null,
          image_storage_file_id: storageFileId || null,
          image_storage_hash: storageHash || null
        })
        .eq('id', albumId).is('cover_image_url', null).select();
      if (error) throw new Error(error.message);
      if (!updated || updated.length === 0) return { album: await getAlbum(albumId), adopted: false };
      invalidateParents();
      await mirrorToItems('album_id', albumId, url);
      return { album: updated[0], adopted: true };
    });
  }

  /* ---- editing identity (used to set the year on legacy albums) ---- */

  // Returns { album } on success or { conflict } when the new (name, year) already
  // belongs to a different album — albums are never silently merged.
  async function updateAlbumIdentity(albumId, { name, releaseYear, artist }) {
    const current = await getAlbum(albumId);
    if (!current) return { notFound: true };

    const nextName = name !== undefined ? (sanitizeSegment(name) || current.name) : current.name;
    const nextYear = releaseYear !== undefined ? parseReleaseYear(releaseYear) : current.release_year;
    const nextKey = normalizeKey(nextName);

    return withLock(`album:${nextKey}|${nextYear ?? ''}`, async () => {
      const other = await findAlbum(nextKey, nextYear);
      if (other && other.id !== albumId) return { conflict: other };

      const patch = { name: nextName, release_year: nextYear };
      if (artist !== undefined) patch.artist = artist ? sanitizeSegment(artist) : null;
      const { data, error } = await db.from('albums').update(patch).eq('id', albumId).select().single();
      if (error) {
        if (error.code === '23505') {
          const again = await findAlbum(nextKey, nextYear);
          return { conflict: again };
        }
        throw new Error(error.message);
      }
      invalidateParents();
      return { album: data };
    });
  }

  return {
    ensureAlbum, ensureSeries,
    getAlbum, getSeries,
    recountAlbum, recountSeries,
    setAlbumArtworkIfMissing, setSeriesArtwork,
    setSeriesArtworkFromUploaded, adoptAlbumArtworkIfMissing, discardRedundantUpload,
    updateAlbumIdentity,
    isImageReferenced, deleteImageIfUnreferenced,
    applyArtwork, artworkForSeriesKey, invalidateParents
  };
}

// Lazily-created process-wide instance wired to the real Supabase client/Drime.
let _default = null;
function getDefault() {
  if (!_default) _default = createArtworkService();
  return _default;
}

module.exports = {
  createArtworkService, getDefault,
  sanitizeSegment, normalizeKey, parseReleaseYear, withLock
};
