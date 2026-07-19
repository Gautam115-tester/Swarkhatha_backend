const express = require('express');
const supabase = require('../lib/supabaseClient');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { decrypt } = require('../lib/crypto');
const drime = require('../lib/drime');

const router = express.Router();

// Public catalog (any logged-in listener)
router.get('/', requireAuth, async (req, res) => {
  const { type, category } = req.query;
  let q = supabase.from('media_items').select('*').order('created_at', { ascending: false });
  if (type) q = q.eq('type', type);
  if (category) q = q.eq('category', category);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ items: data });
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
    if (!existing.cover_image_url && coverImageUrl) update.cover_image_url = coverImageUrl;
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