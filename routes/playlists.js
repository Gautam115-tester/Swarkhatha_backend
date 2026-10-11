const express = require('express');
const supabase = require('../lib/supabaseClient');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const MAX_PLAYLISTS = 10; // keep in sync with enforce_playlist_limit() in migration_playlists.sql
const MAX_NAME_LENGTH = 60;
const TYPES = ['music', 'audio_story'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PostgREST caps each request at ~1000 rows, so page through when reading
// playlist items (10 playlists x many items can pass that).
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

function toDto(p, itemIds) {
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    itemIds,
  };
}

// Loads a playlist only if it belongs to the caller; otherwise sends the
// 404 itself and returns null. (404, not 403, so ids of other people's
// playlists can't be probed.)
async function loadOwned(req, res) {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    res.status(404).json({ error: 'Playlist not found' });
    return null;
  }
  const { data, error } = await supabase
    .from('playlists')
    .select('*')
    .eq('id', id)
    .eq('user_id', req.user.sub)
    .maybeSingle();
  if (error) {
    res.status(500).json({ error: error.message });
    return null;
  }
  if (!data) {
    res.status(404).json({ error: 'Playlist not found' });
    return null;
  }
  return data;
}

function cleanName(raw) {
  return String(raw || '').trim().replace(/\s+/g, ' ');
}

function isDuplicateName(error) {
  return error && (error.code === '23505' || /uq_playlists_user_name/.test(error.message || ''));
}

// All of the caller's playlists, oldest first, each with its ordered item
// ids. The app already holds the full catalog, so it matches ids locally
// (same split of work as /api/media/progress) -- one round trip restores
// everything after a reinstall.
router.get('/', requireAuth, async (req, res) => {
  try {
    const { data: playlists, error } = await supabase
      .from('playlists')
      .select('*')
      .eq('user_id', req.user.sub)
      .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    if (!playlists.length) return res.json({ playlists: [], maxPlaylists: MAX_PLAYLISTS });

    const ids = playlists.map((p) => p.id);
    const rows = await fetchAllRows(() =>
      supabase
        .from('playlist_items')
        .select('playlist_id, media_item_id')
        .in('playlist_id', ids)
        .order('position', { ascending: true })
        .order('added_at', { ascending: true })
    );
    const byPlaylist = new Map(ids.map((id) => [id, []]));
    for (const r of rows) byPlaylist.get(r.playlist_id)?.push(r.media_item_id);

    res.json({
      playlists: playlists.map((p) => toDto(p, byPlaylist.get(p.id) || [])),
      maxPlaylists: MAX_PLAYLISTS,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create a playlist: { name, type: 'music' | 'audio_story' }.
router.post('/', requireAuth, async (req, res) => {
  const name = cleanName(req.body.name);
  const type = req.body.type;
  if (!name) return res.status(400).json({ error: 'Playlist name is required' });
  if (name.length > MAX_NAME_LENGTH) {
    return res.status(400).json({ error: `Playlist name can be at most ${MAX_NAME_LENGTH} characters` });
  }
  if (!TYPES.includes(type)) {
    return res.status(400).json({ error: "type must be 'music' or 'audio_story'" });
  }

  const { count, error: countErr } = await supabase
    .from('playlists')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', req.user.sub);
  if (countErr) return res.status(500).json({ error: countErr.message });
  if (count >= MAX_PLAYLISTS) {
    return res.status(409).json({ error: `You can create up to ${MAX_PLAYLISTS} playlists. Delete one to make a new one.` });
  }

  const { data, error } = await supabase
    .from('playlists')
    .insert({ user_id: req.user.sub, name, type })
    .select()
    .single();
  if (error) {
    if (/PLAYLIST_LIMIT_REACHED/.test(error.message || '')) {
      return res.status(409).json({ error: `You can create up to ${MAX_PLAYLISTS} playlists. Delete one to make a new one.` });
    }
    if (isDuplicateName(error)) {
      return res.status(409).json({ error: 'You already have a playlist with that name.' });
    }
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json({ playlist: toDto(data, []) });
});

// Rename: { name }.
router.put('/:id', requireAuth, async (req, res) => {
  const playlist = await loadOwned(req, res);
  if (!playlist) return;
  const name = cleanName(req.body.name);
  if (!name) return res.status(400).json({ error: 'Playlist name is required' });
  if (name.length > MAX_NAME_LENGTH) {
    return res.status(400).json({ error: `Playlist name can be at most ${MAX_NAME_LENGTH} characters` });
  }
  const { error } = await supabase
    .from('playlists')
    .update({ name, updated_at: new Date().toISOString() })
    .eq('id', playlist.id);
  if (error) {
    if (isDuplicateName(error)) {
      return res.status(409).json({ error: 'You already have a playlist with that name.' });
    }
    return res.status(500).json({ error: error.message });
  }
  res.json({ ok: true });
});

// Delete a playlist (its items go with it via ON DELETE CASCADE).
router.delete('/:id', requireAuth, async (req, res) => {
  const playlist = await loadOwned(req, res);
  if (!playlist) return;
  const { error } = await supabase.from('playlists').delete().eq('id', playlist.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Add one or more items: { mediaItemIds: [...] }. Items already in the
// playlist are skipped; new ones are appended in the order given. Every item
// must match the playlist's type (a music playlist can't hold a story).
router.post('/:id/items', requireAuth, async (req, res) => {
  const playlist = await loadOwned(req, res);
  if (!playlist) return;

  const requested = Array.isArray(req.body.mediaItemIds) ? req.body.mediaItemIds : [];
  const ids = [...new Set(requested.map(String))];
  if (!ids.length) return res.status(400).json({ error: 'mediaItemIds is required' });
  if (ids.length > 200 || ids.some((i) => !UUID_RE.test(i))) {
    return res.status(400).json({ error: 'Invalid mediaItemIds' });
  }

  const { data: media, error: mediaErr } = await supabase
    .from('media_items')
    .select('id, type')
    .in('id', ids);
  if (mediaErr) return res.status(500).json({ error: mediaErr.message });
  if (media.length !== ids.length) {
    return res.status(404).json({ error: 'Some of those items no longer exist' });
  }
  if (media.some((m) => m.type !== playlist.type)) {
    return res.status(400).json({
      error: playlist.type === 'music'
        ? 'This is a music playlist -- only songs can be added to it.'
        : 'This is an audio story playlist -- only episodes can be added to it.',
    });
  }

  const { data: existing, error: existErr } = await supabase
    .from('playlist_items')
    .select('media_item_id, position')
    .eq('playlist_id', playlist.id);
  if (existErr) return res.status(500).json({ error: existErr.message });

  const have = new Set(existing.map((r) => r.media_item_id));
  let nextPos = existing.reduce((m, r) => Math.max(m, r.position), -1) + 1;
  const rows = ids
    .filter((i) => !have.has(i))
    .map((i) => ({ playlist_id: playlist.id, media_item_id: i, position: nextPos++ }));

  if (rows.length) {
    const { error } = await supabase
      .from('playlist_items')
      .upsert(rows, { onConflict: 'playlist_id,media_item_id', ignoreDuplicates: true });
    if (error) return res.status(500).json({ error: error.message });
    await supabase.from('playlists').update({ updated_at: new Date().toISOString() }).eq('id', playlist.id);
  }
  res.json({ ok: true, added: rows.length });
});

// Remove one item from a playlist.
router.delete('/:id/items/:mediaItemId', requireAuth, async (req, res) => {
  const playlist = await loadOwned(req, res);
  if (!playlist) return;
  if (!UUID_RE.test(req.params.mediaItemId)) {
    return res.status(404).json({ error: 'Item not found' });
  }
  const { error } = await supabase
    .from('playlist_items')
    .delete()
    .eq('playlist_id', playlist.id)
    .eq('media_item_id', req.params.mediaItemId);
  if (error) return res.status(500).json({ error: error.message });
  await supabase.from('playlists').update({ updated_at: new Date().toISOString() }).eq('id', playlist.id);
  res.json({ ok: true });
});

module.exports = router;
