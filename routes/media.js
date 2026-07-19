const express = require('express');
const supabase = require('../lib/supabaseClient');
const { requireAuth, requireAdmin } = require('../middleware/auth');

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
 * unsafe as a storage filename (on Backblaze B2 or MediaFire), and
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

// Admin: register metadata for a file already uploaded via /api/storage/upload.
// type = 'music'        -> album is auto-created/matched from albumOrSeries + artistOrNarrator.
// type = 'audio_story'  -> title is composed as StoryTitle_EpNumber_EpTitle server-side,
//                          so the stored title always matches the required naming rule
//                          regardless of what the client sends in `title`.
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  const {
    type, title, artistOrNarrator, albumOrSeries, coverImageUrl, durationSeconds,
    fileSizeBytes, storageProvider, storageAccountId, storageFileId, storagePath, contentLabelId,
    chapterNumber, storyTitle, episodeTitle
  } = req.body;

  if (!type || !storageProvider || !storageAccountId || !storageFileId || !storagePath) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (!['backblaze', 'mediafire'].includes(storageProvider)) {
    return res.status(400).json({ error: "storageProvider must be 'backblaze' or 'mediafire'" });
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
    insertRow.title = composeEpisodeTitle(storyTitle, chapterNumber, episodeTitle);
    insertRow.story_title = sanitizeSegment(storyTitle);
    insertRow.episode_title = episodeTitle ? sanitizeSegment(episodeTitle) : null;
    insertRow.album_or_series = sanitizeSegment(storyTitle); // series grouping = story title
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
// always starting a brand-new series.
router.get('/stories', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('media_items')
    .select('story_title')
    .eq('type', 'audio_story')
    .not('story_title', 'is', null);
  if (error) return res.status(500).json({ error: error.message });

  const counts = {};
  for (const row of data) counts[row.story_title] = (counts[row.story_title] || 0) + 1;
  const stories = Object.entries(counts)
    .map(([storyTitle, episodeCount]) => ({ storyTitle, episodeCount }))
    .sort((a, b) => a.storyTitle.localeCompare(b.storyTitle));

  res.json({ stories });
});

router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
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