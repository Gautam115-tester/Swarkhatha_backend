const express = require('express');
const supabase = require('../lib/supabaseClient');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Aggregate rating + review list for a series, plus the caller's own rating
// so the app can pre-fill "your rating" without a second round trip.
router.get('/:seriesKey', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('story_ratings')
    .select('user_id, rating, review, updated_at, app_users(display_name)')
    .eq('series_key', req.params.seriesKey)
    .order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  const count = data.length;
  const average = count ? data.reduce((sum, r) => sum + r.rating, 0) / count : 0;
  const mine = data.find((r) => r.user_id === req.user.sub);

  res.json({
    average: Math.round(average * 10) / 10,
    count,
    myRating: mine ? { rating: mine.rating, review: mine.review } : null,
    reviews: data
      .filter((r) => r.user_id !== req.user.sub && r.review && r.review.trim())
      .map((r) => ({
        displayName: r.app_users?.display_name || 'A listener',
        rating: r.rating,
        review: r.review,
        updatedAt: r.updated_at,
      })),
  });
});

// Rate (and optionally review) a series. Upsert -- changing your mind just
// overwrites your previous rating rather than creating a second row.
router.post('/:seriesKey', requireAuth, async (req, res) => {
  const { rating, review } = req.body;
  const r = Number(rating);
  if (!Number.isInteger(r) || r < 1 || r > 5) {
    return res.status(400).json({ error: 'rating must be an integer from 1 to 5' });
  }
  const { error } = await supabase.from('story_ratings').upsert({
    user_id: req.user.sub,
    series_key: req.params.seriesKey,
    rating: r,
    review: review && review.trim() ? review.trim() : null,
    updated_at: new Date().toISOString(),
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

router.delete('/:seriesKey', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('story_ratings')
    .delete()
    .eq('user_id', req.user.sub)
    .eq('series_key', req.params.seriesKey);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;
