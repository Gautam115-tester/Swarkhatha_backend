const express = require('express');
const axios = require('axios');
const supabase = require('../lib/supabaseClient');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { decrypt } = require('../lib/crypto');
const drime = require('../lib/drime');
const mediaItemCache = require('../lib/mediaItemCache');
const autoCategorize = require('../lib/autoCategorize');
const multer = require('multer');
const { coverUrl } = require('../lib/coverUrl');
const artworkLib = require('../lib/artwork');
const { sanitizeSegment, parseReleaseYear } = artworkLib;
// Centralized artwork: albums/story_series own their ONE image, everything else
// reaches it through album_id / story_series_id. See lib/artwork.js.
const artwork = artworkLib.getDefault();

const router = express.Router();
const artworkUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB cap, same as /upload-image

// Supabase/PostgREST caps every single request at the project's max-rows
// setting (1000 by default) regardless of how the query is built — there
// is no "just select everything" escape hatch. Once media_items passed
// ~1000 rows, plain select('*') queries started silently truncating,
// which is why whole story series were disappearing from the app: their
// episodes all landed past the 1000-row cutoff of the default
// created_at-desc ordering and were simply never in the response.
// This pages through in PAGE_SIZE chunks via .range() and concatenates
// until a page comes back short, so callers always get the complete
// result set no matter how large the table grows.
const PAGE_SIZE = 1000;
async function fetchAllRows(buildQuery) {
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

// Public catalog (any logged-in listener)
//
// albumId / storySeriesId are the two filters the player needs to build
// an ordered "what plays next" queue (this is what issue 1 — the player
// not auto-advancing — needs from the backend side). When either is
// present the app is asking for one specific album/series' contents, so
// ordering switches from created_at desc (newest-first, right for
// browse/list screens) to actual playback order: album tracks by upload
// order (media_items has no track-number column, so created_at asc is
// the best available proxy), story episodes by chapter_number asc (the
// real, authoritative episode order).
router.get('/', requireAuth, async (req, res) => {
  const { type, category, albumId, storySeriesId } = req.query;

  const orderColumn = storySeriesId ? 'chapter_number' : 'created_at';
  const ascending = Boolean(albumId || storySeriesId);

  const buildQuery = () => {
    let q = supabase.from('media_items').select('*');
    if (type) q = q.eq('type', type);
    if (category) q = q.eq('category', category);
    if (albumId) q = q.eq('album_id', albumId);
    else if (storySeriesId) q = q.eq('story_series_id', storySeriesId);
    return q.order(orderColumn, { ascending });
  };

  try {
    const data = await fetchAllRows(buildQuery);
    // Artwork always comes from the parent album/series (see lib/artwork.js),
    // so every track of an album — and every episode of a series — carries the
    // exact same URL no matter what its own legacy cover column says.
    res.json({ items: await artwork.applyArtwork(data) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Composes "StoryTitle_EpNumber_EpTitle" (or "StoryTitle_EpNumber" when
// no episode title is given — episode title is optional per spec).
// (sanitizeSegment lives in lib/artwork.js so identity keys and stored names agree.)
function composeEpisodeTitle(storyTitle, epNumber, epTitle) {
  const parts = [sanitizeSegment(storyTitle), String(epNumber)];
  if (epTitle && sanitizeSegment(epTitle)) parts.push(sanitizeSegment(epTitle));
  return parts.join('_');
}

function albumJson(a) {
  return {
    id: a.id,
    name: a.name,
    artist: a.artist,
    releaseYear: a.release_year ?? null,
    coverImageUrl: a.cover_image_url || null,
    hasArtwork: Boolean(a.cover_image_url),
    trackCount: a.track_count ?? 0
  };
}

function seriesJson(s) {
  return {
    id: s.id,
    storyTitle: s.title,
    narrator: s.narrator,
    coverImageUrl: s.cover_image_url || null,
    hasArtwork: Boolean(s.cover_image_url),
    episodeCount: s.episode_count ?? 0
  };
}

// Admin: register metadata for a file already uploaded via /api/storage/upload.
// type = 'music'        -> album is resolved by (name + release year) — see
//                          lib/artwork.js ensureAlbum — or by an explicit `albumId`
//                          the admin app got from POST /albums/resolve.
// type = 'audio_story'  -> series is resolved by title (the text before " Ep "), or
//                          by an explicit `storySeriesId`; the episode title is
//                          composed as StoryTitle_EpNumber_EpTitle server-side.
//
// Artwork is NEVER stored per track/episode: the item's cover_image_url is a
// mirror of its parent album/series artwork (the API also resolves it through the
// parent on every read). New clients upload artwork through
// PUT /albums/:id/artwork or PUT /stories/:id/artwork; the cover* fields below
// are only honoured for older admin builds that still upload first.
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  const {
    type, title, artistOrNarrator, albumOrSeries, coverImageUrl, durationSeconds,
    fileSizeBytes, storageProvider, storageAccountId, storageFileId, storageHash, storagePath, contentLabelId,
    chapterNumber, storyTitle, episodeTitle,
    coverStorageAccountId, coverStorageFileId, coverStorageHash,
    releaseYear, albumId, storySeriesId
  } = req.body;

  if (!type || !storageProvider || !storageAccountId || !storageFileId || !storageHash || !storagePath) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (storageProvider !== 'drime') {
    return res.status(400).json({ error: "storageProvider must be 'drime'" });
  }
  if (!['music', 'audio_story'].includes(type)) {
    return res.status(400).json({ error: 'type must be music or audio_story' });
  }

  // The listener app filters/groups by the legacy `category` text column
  // (see music_screen.dart / audio_stories_screen.dart), which predates
  // content_labels. Rather than leaving category null for every new
  // upload — which would silently drop the item out of category
  // browsing in the existing app — resolve the chosen label's name and
  // write it into both columns, so old and new clients stay in sync.
  let categoryText = null;
  if (contentLabelId) {
    const { data: label, error: labelErr } = await supabase
      .from('content_labels').select('name').eq('id', contentLabelId).maybeSingle();
    if (labelErr) return res.status(500).json({ error: 'Label lookup failed: ' + labelErr.message });
    if (!label) return res.status(400).json({ error: 'contentLabelId does not match an existing label' });
    categoryText = label.name;
  }

  const insertRow = {
    type,
    artist_or_narrator: artistOrNarrator,
    cover_image_url: null, // filled from the parent album/series below — never from the request
    duration_seconds: durationSeconds,
    file_size_bytes: fileSizeBytes,
    storage_provider: storageProvider,
    storage_account_id: storageAccountId,
    storage_file_id: storageFileId,
    storage_hash: storageHash,
    storage_path: storagePath,
    content_label_id: contentLabelId || null,
    category: categoryText,
    uploaded_by: req.user.sub
  };

  let parentKind; // 'album' | 'series'
  let parentId;

  if (type === 'music') {
    if (!title) return res.status(400).json({ error: 'title is required for music' });
    try {
      let album = albumId ? await artwork.getAlbum(albumId) : null;
      if (albumId && !album) return res.status(400).json({ error: 'albumId does not match an existing album' });
      if (!album) {
        album = await artwork.ensureAlbum({ name: albumOrSeries, artist: artistOrNarrator, releaseYear });
      }

      // Older admin builds upload a cover for EVERY track before registering.
      // The album is the only owner of artwork, so: adopt the file if the album
      // has none yet, otherwise discard the redundant upload from Drime (only
      // if nothing references it — the same file legitimately comes back when
      // a client re-sends the album's own cover).
      if (coverImageUrl) {
        if (!album.cover_image_url) {
          const adopted = await artwork.adoptAlbumArtworkIfMissing({
            albumId: album.id, url: coverImageUrl,
            accountId: coverStorageAccountId, storageFileId: coverStorageFileId, storageHash: coverStorageHash
          });
          if (adopted.album) album = adopted.album;
        } else if (album.cover_image_url !== coverImageUrl && coverStorageFileId) {
          await artwork.discardRedundantUpload({ accountId: coverStorageAccountId, storageFileId: coverStorageFileId });
        }
      }

      insertRow.title = title;
      insertRow.album_or_series = album.name;
      insertRow.album_id = album.id;
      insertRow.cover_image_url = album.cover_image_url || null;
      parentKind = 'album';
      parentId = album.id;
    } catch (e) {
      return res.status(500).json({ error: 'Album lookup/create failed: ' + e.message });
    }
  } else {
    // audio_story
    if (!storyTitle) return res.status(400).json({ error: 'storyTitle is required for audio_story' });
    if (chapterNumber === undefined || chapterNumber === null || chapterNumber === '') {
      return res.status(400).json({ error: 'chapterNumber (episode number) is required for audio_story' });
    }
    try {
      let series = storySeriesId ? await artwork.getSeries(storySeriesId) : null;
      if (storySeriesId && !series) return res.status(400).json({ error: 'storySeriesId does not match an existing series' });
      if (!series) {
        series = await artwork.ensureSeries({ title: storyTitle, narrator: artistOrNarrator });
      }

      // Older admin builds upload the admin-picked series cover first and send it
      // with the first episode. A series has exactly one image, so it replaces the
      // old one (and the old file is deleted once nothing references it).
      if (coverImageUrl) {
        const updated = await artwork.setSeriesArtworkFromUploaded({
          seriesId: series.id, url: coverImageUrl,
          accountId: coverStorageAccountId, storageFileId: coverStorageFileId, storageHash: coverStorageHash
        });
        if (updated) series = updated;
      }

      insertRow.story_series_id = series.id;
      insertRow.cover_image_url = series.cover_image_url || null;
      insertRow.title = composeEpisodeTitle(series.title, chapterNumber, episodeTitle);
      insertRow.story_title = series.title;
      insertRow.episode_title = episodeTitle ? sanitizeSegment(episodeTitle) : null;
      insertRow.album_or_series = series.title; // series grouping = story title (legacy listener app)
      insertRow.chapter_number = Number(chapterNumber);
      parentKind = 'series';
      parentId = series.id;
    } catch (e) {
      return res.status(500).json({ error: 'Story series lookup/create failed: ' + e.message });
    }
  }

  const { data, error } = await supabase.from('media_items').insert(insertRow).select().single();
  if (error) return res.status(500).json({ error: error.message });

  // Counters are recomputed from the rows (never read-modify-write), so
  // simultaneous uploads can't make them drift.
  try {
    if (parentKind === 'album') await artwork.recountAlbum(parentId);
    else await artwork.recountSeries(parentId);
  } catch (e) {
    console.error('[media create] count refresh failed (continuing):', e.message);
  }

  res.json({ item: data });

  // Fire-and-forget, AFTER responding: only when the admin didn't pick a
  // label themselves (categoryText is null). Never awaited/blocking --
  // an LLM call must never be why an upload takes longer or fails, and
  // autoCategorizeIfMissing is itself best-effort (a genuine "no confident
  // match" just leaves the row as-is, same as if this were never called).
  if (!categoryText) {
    autoCategorize.autoCategorizeIfMissing(data.id).catch((e) =>
      console.error(`[media create] auto-categorize failed for ${data.id} (continuing):`, e.message)
    );
  }
});

// ---------------------------------------------------------------------------
// Artwork endpoints (admin). The two-step flow for new admin builds:
//   1) POST /albums/resolve  (or /stories/resolve) -> find-or-create the parent,
//      tells the client whether it already has artwork.
//   2) Only if it has none: PUT /albums/:id/artwork (or /stories/:id/artwork)
//      with the image bytes. The server decides under a lock; for an album that
//      already has artwork the bytes are dropped and Drime is never touched.
//   3) POST / with albumId / storySeriesId.
// ---------------------------------------------------------------------------

router.post('/albums/resolve', requireAuth, requireAdmin, async (req, res) => {
  const { name, artist, releaseYear } = req.body;
  try {
    const album = await artwork.ensureAlbum({ name, artist, releaseYear });
    res.json({ album: albumJson(album) });
  } catch (e) {
    res.status(500).json({ error: 'Album lookup/create failed: ' + e.message });
  }
});

router.put('/albums/:id/artwork', requireAuth, requireAdmin, artworkUpload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image provided' });
  try {
    const { album, uploaded } = await artwork.setAlbumArtworkIfMissing({
      albumId: req.params.id,
      buffer: req.file.buffer,
      urlFor: (up) => coverUrl(req, up)
    });
    if (!album) return res.status(404).json({ error: 'Album not found' });
    res.json({ album: albumJson(album), uploaded });
  } catch (e) {
    res.status(500).json({ error: 'Album artwork upload failed: ' + e.message });
  }
});

// Fix an album's identity (typically: set the release year on a legacy album, or
// correct the name). Never merges: if the new name+year belongs to another album
// the request is refused with 409 and the conflicting id.
router.patch('/albums/:id', requireAuth, requireAdmin, async (req, res) => {
  const { name, releaseYear, artist } = req.body;
  try {
    const result = await artwork.updateAlbumIdentity(req.params.id, { name, releaseYear, artist });
    if (result.notFound) return res.status(404).json({ error: 'Album not found' });
    if (result.conflict) {
      return res.status(409).json({
        error: 'Another album with this name and release year already exists.',
        conflictAlbumId: result.conflict.id
      });
    }
    // Keep the legacy text column on the tracks in step with a rename.
    if (name !== undefined) {
      const { data: renamed } = await supabase.from('media_items')
        .update({ album_or_series: result.album.name }).eq('album_id', result.album.id).select('id');
      (renamed || []).forEach((row) => mediaItemCache.invalidate(row.id));
    }
    res.json({ album: albumJson(result.album) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/stories/resolve', requireAuth, requireAdmin, async (req, res) => {
  const { title, narrator } = req.body;
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'title is required' });
  try {
    const series = await artwork.ensureSeries({ title, narrator });
    res.json({ series: seriesJson(series) });
  } catch (e) {
    res.status(500).json({ error: 'Story series lookup/create failed: ' + e.message });
  }
});

router.put('/stories/:id/artwork', requireAuth, requireAdmin, artworkUpload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image provided' });
  try {
    const { series, uploaded } = await artwork.setSeriesArtwork({
      seriesId: req.params.id,
      buffer: req.file.buffer,
      urlFor: (up) => coverUrl(req, up)
    });
    if (!series) return res.status(404).json({ error: 'Story series not found' });
    res.json({ series: seriesJson(series), uploaded });
  } catch (e) {
    res.status(500).json({ error: 'Series artwork upload failed: ' + e.message });
  }
});

// Admin: kick off categorizing every existing item that's missing one
// ("old music" that predates this feature, or was uploaded without a
// label picked). Runs in the background -- responds immediately with how
// many rows are queued, since a large catalog backfill can take a while
// (see lib/autoCategorize.js's pacing comment) and there's no reason to
// hold the HTTP request open for it. The admin app can re-check progress
// via GET /backfill-categories/status.
let _backfillStatus = { running: false, done: 0, total: 0, categorized: 0 };

router.post('/backfill-categories', requireAuth, requireAdmin, async (req, res) => {
  if (_backfillStatus.running) {
    return res.status(409).json({ error: 'A backfill is already running', status: _backfillStatus });
  }
  _backfillStatus = { running: true, done: 0, total: 0, categorized: 0 };
  res.json({ started: true });

  try {
    await autoCategorize.backfillMissingCategories({
      onProgress: ({ done, total, categorized }) => {
        _backfillStatus = { running: true, done, total, categorized };
      }
    });
  } catch (e) {
    console.error('[media backfill-categories] failed:', e.message);
  } finally {
    _backfillStatus = { ..._backfillStatus, running: false };
  }
});

router.get('/backfill-categories/status', requireAuth, requireAdmin, async (req, res) => {
  res.json(_backfillStatus);
});

// List albums (music) — used by the admin app to show existing albums,
// and by the listener app for an album-browse view if it wants one later.
router.get('/albums', requireAuth, async (req, res) => {
  // Albums with no tracks (e.g. created by /albums/resolve and then abandoned
  // when an upload failed) are hidden unless includeEmpty=1.
  let q = supabase.from('albums').select('*').order('name').order('release_year', { ascending: false });
  if (req.query.includeEmpty !== '1') q = q.gt('track_count', 0);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ albums: data });
});

// List distinct story series (audio_story) with episode counts — lets the
// admin app show "add another episode to an existing story" instead of
// always starting a brand-new series. Now backed by the story_series
// table (see migration_story_series.sql) instead of scanning every
// audio_story row and grouping by story_title text on every request.
router.get('/stories', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('story_series')
    .select('*')
    .order('title');
  if (error) return res.status(500).json({ error: error.message });

  const stories = data.map(seriesJson);
  res.json({ stories });
});

// List episodes of one story series, ordered by episode/chapter number —
// this is what the listener app should call when the user taps an audio
// series, so it can render "Episode N — Episode Title" per row instead
// of just the composed StoryTitle_N_Title `title` field. Episode title
// is optional (per the upload spec), so `episodeTitle` may come back null.
router.get('/stories/:id/episodes', requireAuth, async (req, res) => {
  const { data: series, error: seriesErr } = await supabase
    .from('story_series').select('*').eq('id', req.params.id).maybeSingle();
  if (seriesErr) return res.status(500).json({ error: seriesErr.message });
  if (!series) return res.status(404).json({ error: 'Story series not found' });

  let data;
  try {
    data = await fetchAllRows(() =>
      supabase.from('media_items').select('*')
        .eq('story_series_id', req.params.id)
        .order('chapter_number', { ascending: true })
    );
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const episodes = data.map((m) => ({
    id: m.id,
    episodeNumber: m.chapter_number,
    episodeTitle: m.episode_title || null,
    title: m.title, // composed "StoryTitle_N_Title" — kept for the legacy client
    coverImageUrl: series.cover_image_url || m.cover_image_url || null, // ONE image per series
    durationSeconds: m.duration_seconds,
    fileSizeBytes: m.file_size_bytes,
    category: m.category
  }));

  res.json({ series: seriesJson(series), episodes });
});

// Admin: manually set/replace a story series' cover image, without
// needing to upload a whole new episode to trigger the cover-replace
// path in the artwork service (lib/artwork.js) above. Needed because a series' Drime
// cover file can go missing on its own (deleted by hand directly on
// Drime, as opposed to being replaced through this app) — this lets the
// admin re-upload just the image and point the series at it.
// Body: { coverImageUrl, coverStorageAccountId, coverStorageFileId,
// coverStorageHash } — get these from POST /api/storage/upload-image
// first (same upload-then-register two-step every other cover already
// uses; see lib/coverImageStorage.js). New admin builds use PUT /stories/:id/artwork
// instead, which uploads and attaches in one atomic, de-duplicated step.
router.patch('/stories/:id/cover', requireAuth, requireAdmin, async (req, res) => {
  const { coverImageUrl, coverStorageAccountId, coverStorageFileId, coverStorageHash } = req.body;
  if (!coverImageUrl) {
    return res.status(400).json({ error: 'coverImageUrl is required — upload the image via PUT /stories/:id/artwork instead (or POST /api/storage/upload-image first)' });
  }
  try {
    const series = await artwork.getSeries(req.params.id);
    if (!series) return res.status(404).json({ error: 'Story series not found' });
    // Repoints the series at the uploaded file, mirrors it onto every episode and
    // deletes the previous file only if nothing references it any more.
    const updated = await artwork.setSeriesArtworkFromUploaded({
      seriesId: req.params.id, url: coverImageUrl,
      accountId: coverStorageAccountId, storageFileId: coverStorageFileId, storageHash: coverStorageHash
    });
    res.json({ series: seriesJson(updated || series) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Same "is this episode still worth resuming" threshold AppState uses on
// the Flutter client (see AppState._resumableCeiling) -- kept in sync by
// hand since there's no shared config between the two codebases. An
// episode at or past this fraction played is treated as finished rather
// than in-progress.
const RESUMABLE_CEILING = 0.95;

// "34s" for under a minute, "2m" for under an hour, "1h 5m" beyond that --
// remaining-time label for the /continue-listening response.
function formatRemainingTime(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
}

// "just now" / "3 minutes ago" / "2 hours ago" / "45 days ago" / "2 years
// ago" -- how long since an ISO timestamp, for the /continue-listening
// response. Stays in whole days through day 364, then rolls over into
// whole years from day 365 on, matching the Flutter client's
// formatRelativeTime (duration_format.dart) so the two never disagree if
// a future client (web/admin) starts using this endpoint.
function formatTimeAgo(isoString) {
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(isoString).getTime()) / 1000));
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? '' : 's'} ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 365) return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
  const diffYear = Math.floor(diffDay / 365);
  return `${diffYear} year${diffYear === 1 ? '' : 's'} ago`;
}

// All of the current listener's saved playback positions (audio stories
// only -- see PlaybackHandler on the Flutter side, music never writes a
// resume checkpoint). Returned as plain rows rather than joined against
// media_items: the app always already has the full catalog loaded
// locally and matches by id, the same division of labour the client
// already uses for series/album grouping (see episodesFor/audioSeries in
// app_state.dart). Powers the "Continue Playing" home-screen row and the
// per-episode resume indicators on the series/episode-list screen.
router.get('/progress', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('play_progress')
    .select('media_item_id, position_seconds, updated_at')
    .eq('user_id', req.user.sub);
  if (error) return res.status(500).json({ error: error.message });
  res.json({
    progress: data.map((r) => ({
      mediaItemId: r.media_item_id,
      positionSeconds: r.position_seconds,
      updatedAt: r.updated_at
    }))
  });
});

// Netflix-style "Continue Playing" row, computed server-side. NOTE: the
// Flutter listener app does NOT call this today -- it already has the full
// catalog loaded locally and does this same grouping client-side (see
// AppState.continuePlayingStories), which avoids an extra round trip. This
// endpoint exists to match the agreed API design 1:1 for any other client
// (a future web/TV app, admin dashboard, etc.) that doesn't already have
// the catalog in memory. One entry per story series -- whichever episode
// was most recently left partway through -- sorted most-recent-first.
// Finished (or basically finished, >=95% played) episodes are dropped
// entirely, same threshold the Flutter client already uses.
router.get('/continue-listening', requireAuth, async (req, res) => {
  const { data: progressRows, error: progressErr } = await supabase
    .from('play_progress')
    .select('media_item_id, position_seconds, updated_at')
    .eq('user_id', req.user.sub);
  if (progressErr) return res.status(500).json({ error: progressErr.message });
  if (!progressRows.length) return res.json([]);

  const { data: items, error: itemsErr } = await supabase
    .from('media_items')
    .select('id, title, episode_title, chapter_number, cover_image_url, duration_seconds, album_or_series, story_series_id')
    .in('id', progressRows.map((r) => r.media_item_id))
    .eq('type', 'audio_story');
  if (itemsErr) return res.status(500).json({ error: itemsErr.message });
  const resolvedItems = await artwork.applyArtwork(items);
  const itemById = new Map(resolvedItems.map((m) => [m.id, m]));

  const bySeriesKey = new Map();
  for (const row of progressRows) {
    const item = itemById.get(row.media_item_id);
    if (!item) continue; // music, or the item was deleted since
    const duration = item.duration_seconds;
    if (!duration || duration <= 0) continue;
    const fraction = row.position_seconds / duration;
    if (fraction <= 0 || fraction >= RESUMABLE_CEILING) continue; // never started, or basically finished

    const key = item.story_series_id || item.album_or_series || item.id;
    const existing = bySeriesKey.get(key);
    if (!existing || new Date(row.updated_at) > new Date(existing.row.updated_at)) {
      bySeriesKey.set(key, { row, item });
    }
  }

  const result = Array.from(bySeriesKey.values())
    .sort((a, b) => new Date(b.row.updated_at) - new Date(a.row.updated_at))
    .map(({ row, item }) => ({
      story_id: item.story_series_id || item.id,
      episode_id: item.id,
      title: item.album_or_series || item.title,
      episode: `S1 E${item.chapter_number ?? ''}`,
      episode_title: item.episode_title || null,
      thumbnail: item.cover_image_url,
      duration: item.duration_seconds,
      current_position: row.position_seconds,
      remaining_time: formatRemainingTime(item.duration_seconds - row.position_seconds),
      completion_percentage: Math.round((row.position_seconds / item.duration_seconds) * 100),
      last_played: formatTimeAgo(row.updated_at)
    }));

  res.json(result);
});

// Convenience alias for PUT /:id/progress using the flatter request shape
// from the Continue Listening spec (episode_id/current_position in the
// body instead of :id as a route param). Writes to the exact same
// play_progress row, so a client can use whichever shape is more
// convenient -- both feed /progress and /continue-listening identically.
// `duration` and `story_id` in the request are accepted but not stored
// separately: duration is already known from media_items.duration_seconds,
// and story_id is derivable from the episode's story_series_id.
router.post('/save-progress', requireAuth, async (req, res) => {
  const { episode_id, current_position } = req.body;
  if (!episode_id || current_position == null) {
    return res.status(400).json({ error: 'episode_id and current_position are required' });
  }
  const { error } = await supabase.from('play_progress').upsert({
    user_id: req.user.sub,
    media_item_id: episode_id,
    position_seconds: current_position,
    updated_at: new Date().toISOString()
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  const { data: item } = await supabase.from('media_items').select('*').eq('id', req.params.id).single();

  // Best-effort: also remove the underlying file from Drime so deleting
  // a media item doesn't leave storage space silently occupied forever.
  // A failure here (account gone, token revoked, file already missing)
  // should never block removing the catalog row itself.
  if (item?.storage_account_id && item?.storage_file_id) {
    try {
      const { data: account } = await supabase.from('storage_accounts').select('*').eq('id', item.storage_account_id).single();
      if (account) {
        const creds = JSON.parse(decrypt(account.credentials_enc));
        await drime.deleteFile({ accessToken: creds.accessToken, fileEntryId: item.storage_file_id });
      }
    } catch (e) {
      console.error('[media delete] failed to delete underlying Drime file (continuing):', e.response?.data?.message || e.message);
    }
  }

  const { error } = await supabase.from('media_items').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  mediaItemCache.invalidate(req.params.id); // don't let a deleted item keep resolving from cache — see lib/mediaItemCache.js

  // Counters used to only ever go up. Recompute from the rows so they stay true.
  try {
    if (item?.album_id) await artwork.recountAlbum(item.album_id);
    if (item?.story_series_id) await artwork.recountSeries(item.story_series_id);
  } catch (e) {
    console.error('[media delete] count refresh failed (continuing):', e.message);
  }

  // Best-effort: evict this item's edge-cached audio bytes so it stops
  // being servable from a warm Cloudflare cache immediately, rather than
  // waiting for CACHE_MAX_AGE_SECONDS. This only reaches whichever
  // Cloudflare data center handles this one request, not every colo —
  // it's a nice-to-have, not the actual safety net. The real bound on
  // how long deleted content can still be heard is the media token's
  // own short TTL (see signMediaToken in middleware/auth.js): once the
  // row above is gone, resolve-media 404s on any cache miss, and no new
  // token can ever be minted for this id again — so worst case exposure
  // is whatever time was left on an already-issued token, not days.
  if (process.env.AUDIO_CDN_BASE_URL && process.env.WORKER_INTERNAL_SECRET) {
    axios.post(
      `${process.env.AUDIO_CDN_BASE_URL.replace(/\/$/, '')}/internal/purge/${req.params.id}`,
      null,
      { headers: { 'X-Internal-Secret': process.env.WORKER_INTERNAL_SECRET }, timeout: 5000 }
    ).catch((e) => {
      console.error('[media delete] failed to purge edge cache (continuing):', e.response?.data || e.message);
    });
  }

  res.json({ ok: true });
});

// Resume position
router.put('/:id/progress', requireAuth, async (req, res) => {
  const { positionSeconds } = req.body;
  const { error } = await supabase.from('play_progress').upsert({
    user_id: req.user.sub, media_item_id: req.params.id,
    position_seconds: positionSeconds, updated_at: new Date().toISOString()
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Favorites
router.post('/:id/favorite', requireAuth, async (req, res) => {
  const { error } = await supabase.from('favorites').insert({ user_id: req.user.sub, media_item_id: req.params.id });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});
router.delete('/:id/favorite', requireAuth, async (req, res) => {
  const { error } = await supabase.from('favorites').delete()
    .eq('user_id', req.user.sub).eq('media_item_id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;