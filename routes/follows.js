const express = require('express');
const supabase = require('../lib/supabaseClient');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// The signed-in listener's own followed series, most recently followed
// first -- powers the "Following" list in the app.
router.get('/', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('story_follows')
    .select('series_key, series_title, cover_image_url, created_at')
    .eq('user_id', req.user.sub)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ follows: data });
});

// Follow (or re-follow) a series. Upsert so tapping "Follow" again after
// unfollowing just works instead of erroring on the duplicate primary key.
router.post('/', requireAuth, async (req, res) => {
  const { seriesKey, seriesTitle, coverImageUrl } = req.body;
  if (!seriesKey || !seriesTitle) {
    return res.status(400).json({ error: 'seriesKey and seriesTitle are required' });
  }
  const { error } = await supabase.from('story_follows').upsert({
    user_id: req.user.sub,
    series_key: seriesKey,
    series_title: seriesTitle,
    cover_image_url: coverImageUrl || null,
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Unfollow. :seriesKey must be percent-encoded by the caller (series titles
// can contain "/" and other characters that would otherwise break routing).
router.delete('/:seriesKey', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('story_follows')
    .delete()
    .eq('user_id', req.user.sub)
    .eq('series_key', req.params.seriesKey);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;
