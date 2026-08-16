/**
 * Automatic categorization via Groq -- fills in media_items.category
 * (and content_label_id) ONLY when it's currently missing, for both:
 *  - a single newly-created item (called from routes/media.js right after
 *    insert, when the admin didn't pick a label themselves)
 *  - every existing item still missing one (backfillMissingCategories,
 *    triggered from the admin app -- see routes/media.js's
 *    POST /backfill-categories)
 *
 * Deliberately never touches a row that already has a category -- an
 * admin's own explicit choice always wins. See groq.suggestCategory for
 * why a low-confidence guess is skipped entirely rather than forced.
 */
const supabase = require('./supabaseClient');
const groq = require('./groq');
const groqAccountCache = require('./groqAccountCache');
const mediaItemCache = require('./mediaItemCache');
const { decrypt } = require('./crypto');

async function activeLabelNames(type) {
  const { data, error } = await supabase
    .from('content_labels')
    .select('name, applies_to')
    .eq('is_active', true);
  if (error) throw new Error(error.message);
  return (data || [])
    .filter((l) => l.applies_to === type || l.applies_to === 'both')
    .map((l) => l.name);
}

// Matches routes/transcripts.js's loadGroqKey() exactly -- groq_accounts
// stores a JSON blob (credentials_enc), not a bare encrypted string.
function loadGroqKey(account) {
  return JSON.parse(decrypt(account.credentials_enc)).apiKey;
}

// One Groq call, one account from the pool, with the same 429-rotation
// spirit as transliterateToHinglish -- a category suggestion is much
// cheaper/rarer than a transcription job, so this keeps it simple (one
// retry against a second account) rather than the fuller batch-splitting
// logic transcripts.js needs.
async function suggestCategoryWithRetry(args) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const account = await groqAccountCache.pick();
    try {
      return await groq.suggestCategory({ ...args, apiKey: loadGroqKey(account) });
    } catch (e) {
      lastErr = e;
      if (e.response?.status === 429) {
        const msg = groq.extractErrorMessage(e);
        groqAccountCache.markRateLimited(account.id, groq.parseRetryAfterMs(msg));
        continue; // try the next pooled account
      }
      throw e; // not a rate limit -- no point retrying immediately
    }
  }
  throw lastErr;
}

/**
 * Categorizes exactly one media item, but only if it doesn't already have
 * one. Best-effort by design: any failure here (Groq down, no active
 * accounts, low-confidence null) just leaves the row as it was -- this
 * must never be why an upload fails, so callers always fire this
 * unawaited/fire-and-forget rather than blocking on it.
 */
async function autoCategorizeIfMissing(mediaItemId) {
  const { data: row, error } = await supabase
    .from('media_items')
    .select('id, type, title, artist_or_narrator, album_or_series, category')
    .eq('id', mediaItemId)
    .maybeSingle();
  if (error || !row || row.category) return { skipped: true };

  const labelNames = await activeLabelNames(row.type);
  const chosen = await suggestCategoryWithRetry({
    title: row.title,
    artistOrNarrator: row.artist_or_narrator,
    albumOrSeries: row.album_or_series,
    type: row.type,
    labelNames
  });
  if (!chosen) return { skipped: true };

  const { data: label } = await supabase
    .from('content_labels').select('id').eq('name', chosen).maybeSingle();

  const { error: updateErr } = await supabase
    .from('media_items')
    .update({ category: chosen, content_label_id: label?.id || null })
    .eq('id', mediaItemId);
  if (updateErr) throw new Error(updateErr.message);

  mediaItemCache.invalidate(mediaItemId);
  return { skipped: false, category: chosen };
}

/**
 * Backfill for every existing item missing a category ("old music" --
 * see routes/media.js's POST /backfill-categories, admin-triggered).
 * Runs sequentially with a small delay between items rather than in
 * parallel: this pool of Groq accounts is shared with the transcription
 * pipeline (routes/transcripts.js), and a burst of N simultaneous
 * category calls would just trade transcription rate-limit headroom for
 * categorization throughput, not actually go faster overall once 429s
 * start rotating everyone through cooldown.
 */
async function backfillMissingCategories({ onProgress } = {}) {
  const { data: rows, error } = await supabase
    .from('media_items')
    .select('id')
    .is('category', null);
  if (error) throw new Error(error.message);

  let done = 0;
  let categorized = 0;
  for (const row of rows || []) {
    try {
      const result = await autoCategorizeIfMissing(row.id);
      if (!result.skipped) categorized++;
    } catch (e) {
      console.error(`[autoCategorize] backfill failed for ${row.id} (continuing):`, e.message);
    }
    done++;
    if (onProgress) onProgress({ done, total: rows.length, categorized });
    // Small pacing gap -- see comment above on why this stays sequential.
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return { total: rows?.length || 0, categorized };
}

module.exports = { autoCategorizeIfMissing, backfillMissingCategories };