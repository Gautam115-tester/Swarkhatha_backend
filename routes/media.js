const express = require('express');
const supabase = require('../lib/supabaseClient');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { decrypt } = require('../lib/crypto');
const drime = require('../lib/drime');
const mediaItemCache = require('../lib/mediaItemCache');

const router = express.Router();

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
    res.json({ items: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------
 * Filename/title sanitizer for the story-episode composition rule.
 * Strips underscores (the field separator) and characters that are
 * unsafe as a storage filename (on Drime), and
 * collapses whitespace. Applied to every segment independently so a
 * story title containing "_" can't be mistaken for an extra field
 * when the parts are later split.
 * ------------------------------------------------------------------ */
function sanitizeSegment(value) {
  return String(value || '')
    .replace(/_/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

// Composes "StoryTitle_EpNumber_EpTitle" (or "StoryTitle_EpNumber" when
// no episode title is given — episode title is optional per spec).
function composeEpisodeTitle(storyTitle, epNumber, epTitle) {
  const parts = [sanitizeSegment(storyTitle), String(epNumber)];
  if (epTitle && sanitizeSegment(epTitle)) parts.push(sanitizeSegment(epTitle));
  return parts.join('_');
}

// Find-or-create an album row for a music upload. Matches on
// (name, artist) so re-uploading tracks from the same album reuses
// the same album_id instead of creating a duplicate; track_count is
// incremented server-side so it never drifts from actual inserts.
async function findOrCreateAlbum({ name, artist, coverImageUrl }) {
  const albumName = sanitizeSegment(name) || 'Unknown Album';
  const albumArtist = artist ? sanitizeSegment(artist) : null;

  let findQuery = supabase.from('albums').select('*').eq('name', albumName);
  // .eq('artist', null) never matches in Postgres (NULL <> NULL) — use .is() for the null case
  findQuery = albumArtist ? findQuery.eq('artist', albumArtist) : findQuery.is('artist', null);
  const { data: existing, error: findErr } = await findQuery.maybeSingle();
  if (findErr) throw new Error(findErr.message);

  if (existing) {
    const update = { track_count: existing.track_count + 1 };
    if (!existing.cover_image_url && coverImageUrl) update.cover_image_url = coverImageUrl;
    const { data: updated, error: updErr } = await supabase
      .from('albums').update(update).eq('id', existing.id).select().single();
    if (updErr) throw new Error(updErr.message);
    return updated;
  }

  const { data: created, error: createErr } = await supabase
    .from('albums')
    .insert({ name: albumName, artist: albumArtist, cover_image_url: coverImageUrl, track_count: 1 })
    .select().single();
  if (createErr) throw new Error(createErr.message);
  return created;
}

// Find-or-create a story_series row for an audio_story upload — the
// audio-story equivalent of findOrCreateAlbum() above. Matches on title
// alone (a story keeps one series row across episodes even if a later
// episode credits a different narrator or a new cover gets set), and
// episode_count is incremented server-side so it never drifts, exactly
// like albums.track_count. Requires migration_story_series.sql to have
// been run — if the story_series table doesn't exist yet, this throws
// and the caller surfaces that as a 500 with the real Postgres error.
async function findOrCreateStorySeries({ title, narrator, coverImageUrl }) {
  const seriesTitle = sanitizeSegment(title);

  const { data: existing, error: findErr } = await supabase
    .from('story_series').select('*').eq('title', seriesTitle).maybeSingle();
  if (findErr) throw new Error(findErr.message);

  if (existing) {
    const update = { episode_count: existing.episode_count + 1 };
    // Unlike albums (first cover wins, see findOrCreateAlbum), a
    // story's cover can be replaced any time the admin manually
    // uploads a fresh one — the caller in POST /api/media then
    // propagates it to every existing episode of the series too.
    if (coverImageUrl) update.cover_image_url = coverImageUrl;
    if (!existing.narrator && narrator) update.narrator = narrator;
    const { data: updated, error: updErr } = await supabase
      .from('story_series').update(update).eq('id', existing.id).select().single();
    if (updErr) throw new Error(updErr.message);
    return updated;
  }

  const { data: created, error: createErr } = await supabase
    .from('story_series')
    .insert({ title: seriesTitle, narrator: narrator || null, cover_image_url: coverImageUrl || null, episode_count: 1 })
    .select().single();
  if (createErr) throw new Error(createErr.message);
  return created;
}

// Admin: register metadata for a file already uploaded via /api/storage/upload.
// type = 'music'        -> album is auto-created/matched from albumOrSeries + artistOrNarrator.
// type = 'audio_story'  -> title is composed as StoryTitle_EpNumber_EpTitle server-side,
//                          so the stored title always matches the required naming rule
//                          regardless of what the client sends in `title`.
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  const {
    type, title, artistOrNarrator, albumOrSeries, coverImageUrl, durationSeconds,
    fileSizeBytes, storageProvider, storageAccountId, storageFileId, storageHash, storagePath, contentLabelId,
    chapterNumber, storyTitle, episodeTitle
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
    cover_image_url: coverImageUrl,
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

  if (type === 'music') {
    if (!title) return res.status(400).json({ error: 'title is required for music' });
    try {
      const album = await findOrCreateAlbum({
        name: albumOrSeries, artist: artistOrNarrator, coverImageUrl
      });
      insertRow.title = title;
      insertRow.album_or_series = album.name;
      insertRow.album_id = album.id;
      // Album art is shared across every track in the album: once the
      // album has a cover_image_url (set by this upload or an earlier
      // one), every track uses that same image rather than whatever
      // this particular upload individually sent. Also backfill any
      // earlier tracks of this album that were inserted before a cover
      // existed, so the whole album is consistent going forward.
      insertRow.cover_image_url = album.cover_image_url || coverImageUrl || null;
      if (album.cover_image_url) {
        const { data: backfilled, error: backfillErr } = await supabase.from('media_items')
          .update({ cover_image_url: album.cover_image_url })
          .eq('album_id', album.id)
          .is('cover_image_url', null)
          .select('id');
        if (backfillErr) console.error('[media create] album cover backfill failed (continuing):', backfillErr.message);
        // Bulk updates like this bypass the single-id DELETE invalidation
        // in mediaItemCache — invalidate every row actually touched so a
        // long-TTL cache (see lib/mediaItemCache.js) can't keep serving
        // the old (null) cover_image_url for up to TTL_MS.
        else if (backfilled) backfilled.forEach((row) => mediaItemCache.invalidate(row.id));
      }
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
      const series = await findOrCreateStorySeries({
        title: storyTitle, narrator: artistOrNarrator, coverImageUrl
      });
      insertRow.story_series_id = series.id;
      insertRow.cover_image_url = series.cover_image_url || null;
      // If the admin uploaded a fresh cover on this request, it's now
      // the series' cover (findOrCreateStorySeries already saved it on
      // the series row above) — push it onto every episode already in
      // this series too, so a manual re-cover takes effect everywhere
      // immediately, not just for episodes uploaded from now on.
      if (coverImageUrl) {
        const { data: propagated, error: propErr } = await supabase.from('media_items')
          .update({ cover_image_url: coverImageUrl })
          .eq('story_series_id', series.id)
          .select('id');
        if (propErr) console.error('[media create] story cover propagation failed (continuing):', propErr.message);
        // Same reasoning as the album backfill above — this can touch
        // many existing episodes at once, so each affected id needs an
        // explicit invalidate() rather than waiting out the cache TTL.
        else if (propagated) propagated.forEach((row) => mediaItemCache.invalidate(row.id));
      }
    } catch (e) {
      return res.status(500).json({ error: 'Story series lookup/create failed: ' + e.message });
    }
    insertRow.title = composeEpisodeTitle(storyTitle, chapterNumber, episodeTitle);
    insertRow.story_title = sanitizeSegment(storyTitle);
    insertRow.episode_title = episodeTitle ? sanitizeSegment(episodeTitle) : null;
    insertRow.album_or_series = sanitizeSegment(storyTitle); // series grouping = story title (legacy listener app)
    insertRow.chapter_number = Number(chapterNumber);
  }

  const { data, error } = await supabase.from('media_items').insert(insertRow).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ item: data });
});

// List albums (music) — used by the admin app to show existing albums,
// and by the listener app for an album-browse view if it wants one later.
router.get('/albums', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('albums').select('*').order('name');
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

  const stories = data.map((s) => ({
    id: s.id,
    storyTitle: s.title,
    narrator: s.narrator,
    coverImageUrl: s.cover_image_url,
    episodeCount: s.episode_count
  }));
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
    coverImageUrl: m.cover_image_url,
    durationSeconds: m.duration_seconds,
    fileSizeBytes: m.file_size_bytes,
    category: m.category
  }));

  res.json({
    series: {
      id: series.id,
      storyTitle: series.title,
      narrator: series.narrator,
      coverImageUrl: series.cover_image_url,
      episodeCount: series.episode_count
    },
    episodes
  });
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