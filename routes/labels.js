const express = require('express');
const supabase = require('../lib/supabaseClient');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Any logged-in user (admin app + listener app both read this for dropdowns/filters)
// ?appliesTo=music | audio_story  filters to labels usable for that type ('both' always included)
router.get('/', requireAuth, async (req, res) => {
  const { appliesTo } = req.query;
  let q = supabase.from('content_labels').select('*').eq('is_active', true).order('sort_order');
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  const filtered = appliesTo
    ? data.filter((l) => l.applies_to === appliesTo || l.applies_to === 'both')
    : data;

  res.json({ labels: filtered });
});

// Admin: create a new label option
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  const { name, appliesTo = 'both', sortOrder = 0 } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!['music', 'audio_story', 'both'].includes(appliesTo)) {
    return res.status(400).json({ error: "appliesTo must be 'music', 'audio_story', or 'both'" });
  }

  const { data, error } = await supabase.from('content_labels')
    .insert({ name, applies_to: appliesTo, sort_order: sortOrder })
    .select().single();

  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'That label already exists for this type' });
    return res.status(500).json({ error: error.message });
  }
  res.json({ label: data });
});

// Admin: rename, re-scope, reorder, or deactivate a label
router.patch('/:id', requireAuth, requireAdmin, async (req, res) => {
  const { name, appliesTo, sortOrder, isActive } = req.body;
  if (appliesTo && !['music', 'audio_story', 'both'].includes(appliesTo)) {
    return res.status(400).json({ error: "appliesTo must be 'music', 'audio_story', or 'both'" });
  }
  const update = {};
  if (name !== undefined) update.name = name;
  if (appliesTo !== undefined) update.applies_to = appliesTo;
  if (sortOrder !== undefined) update.sort_order = sortOrder;
  if (isActive !== undefined) update.is_active = isActive;
  if (Object.keys(update).length === 0) return res.status(400).json({ error: 'Nothing to update' });

  const { data, error } = await supabase.from('content_labels')
    .update(update).eq('id', req.params.id).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ label: data });
});

// Admin: hard delete (only safe if nothing references it — media_items.content_label_id
// has no ON DELETE CASCADE on purpose, so this will fail loudly if in use; deactivate instead).
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  const { error } = await supabase.from('content_labels').delete().eq('id', req.params.id);
  if (error) return res.status(409).json({ error: 'Label is in use by existing media — deactivate it instead of deleting' });
  res.json({ ok: true });
});

module.exports = router;
