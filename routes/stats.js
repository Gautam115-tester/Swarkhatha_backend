const express = require('express');
const supabase = require('../lib/supabaseClient');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Append one "completed play-through" event. Called by the listener app's
// PlaybackHandler._onTrackCompleted for both music and audio stories.
// Deliberately best-effort: stats are a nice-to-have, never worth failing
// playback over, so this always responds ok even if the insert itself
// fails (logged server-side for visibility instead).
router.post('/listening-event', requireAuth, async (req, res) => {
  const { mediaItemId, type, category, artistOrNarrator, durationSeconds } = req.body;
  if (!mediaItemId || !['music', 'audio_story'].includes(type)) {
    return res.status(400).json({ error: 'mediaItemId and a valid type are required' });
  }
  const { error } = await supabase.from('listening_events').insert({
    user_id: req.user.sub,
    media_item_id: mediaItemId,
    type,
    category: category || null,
    artist_or_narrator: artistOrNarrator || null,
    duration_seconds: durationSeconds || null,
  });
  if (error) console.error('[listening-event] insert failed:', error.message);
  res.json({ ok: true });
});

// Aggregated "Year in Audio" style summary over the last `sinceDays` days
// (default 365 = a rolling year, so this works the same in January as it
// does in December instead of only meaning something once a year).
router.get('/listening', requireAuth, async (req, res) => {
  const sinceDays = Number(req.query.sinceDays) || 365;
  const since = new Date(Date.now() - sinceDays * 86400000).toISOString();

  const { data, error } = await supabase
    .from('listening_events')
    .select('type, category, artist_or_narrator, duration_seconds, played_at')
    .eq('user_id', req.user.sub)
    .gte('played_at', since);
  if (error) return res.status(500).json({ error: error.message });

  const totalSeconds = data.reduce((sum, e) => sum + (e.duration_seconds || 0), 0);
  const musicCount = data.filter((e) => e.type === 'music').length;
  const storyCount = data.filter((e) => e.type === 'audio_story').length;

  const topBy = (key) => {
    const counts = {};
    for (const e of data) {
      const v = e[key];
      if (!v) continue;
      counts[v] = (counts[v] || 0) + 1;
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));
  };

  // Longest run of consecutive calendar days with at least one completed
  // listen -- a "wrapped"-style headline number alongside the raw totals.
  const days = [...new Set(data.map((e) => e.played_at.slice(0, 10)))].sort();
  let longestStreak = days.length ? 1 : 0;
  let current = 1;
  for (let i = 1; i < days.length; i++) {
    const diffDays = Math.round((new Date(days[i]) - new Date(days[i - 1])) / 86400000);
    current = diffDays === 1 ? current + 1 : 1;
    longestStreak = Math.max(longestStreak, current);
  }

  res.json({
    sinceDays,
    totalSeconds,
    itemsCompleted: data.length,
    musicCount,
    storyCount,
    topCategories: topBy('category'),
    topArtistsOrNarrators: topBy('artist_or_narrator'),
    longestStreakDays: longestStreak,
    activeDays: days.length,
  });
});

module.exports = router;
