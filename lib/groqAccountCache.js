/**
 * Pool of admin-added groq_accounts, picked round-robin (oldest
 * last_used_at first) — the same spirit as routes/storage.js auto-picking
 * the Drime account with the most free space, except there's no "free
 * space" concept for an API key. The fair thing to rotate on instead is
 * "hasn't been used in the longest time", which spreads load evenly across
 * however many keys the admin has pooled.
 *
 * Also tracks a lightweight in-memory cooldown: routes/transcripts.js calls
 * markRateLimited() whenever Groq answers with 429, and a cooling-down
 * account is skipped by pick() until the cooldown passes — without this, a
 * key that just got rate-limited would likely get picked again on the very
 * next batch/episode and fail again immediately.
 */
const supabase = require('./supabaseClient');

const COOLDOWN_MS = Number(process.env.GROQ_COOLDOWN_MS || 60 * 1000); // 1 min
const inMemoryCooldown = new Map(); // accountId -> cooldownUntil (ms epoch)

async function listActive() {
  const { data, error } = await supabase.from('groq_accounts').select('*').eq('is_active', true);
  if (error) throw new Error(error.message);
  return data || [];
}

// Picks the least-recently-used active account that isn't currently
// cooling down. If EVERY active account is cooling down, picks the one
// whose cooldown ends soonest rather than hard-failing — a slightly stale
// pick is better than refusing to try at all.
async function pick() {
  const accounts = await listActive();
  if (accounts.length === 0) {
    throw new Error('No active Groq accounts configured — add one from the admin app first.');
  }

  const now = Date.now();
  const available = accounts.filter((a) => {
    const until = inMemoryCooldown.get(a.id);
    return !until || until <= now;
  });
  const pool = available.length > 0 ? available : accounts;
  pool.sort((a, b) => new Date(a.last_used_at || 0) - new Date(b.last_used_at || 0));
  const chosen = pool[0];

  await supabase.from('groq_accounts').update({ last_used_at: new Date().toISOString() }).eq('id', chosen.id);
  return chosen;
}

// `explicitMs` lets a caller (routes/transcripts.js) pass the actual wait
// time Groq reported in the 429 body -- parsed via groq.parseRetryAfterMs()
// -- since that's frequently minutes for an ASPH-style limit, not the
// flat COOLDOWN_MS default below. Falls back to COOLDOWN_MS when no
// explicit value is given (or it's shorter than the default), so this
// never cools down for LESS time than before.
function markRateLimited(accountId, explicitMs) {
  const ms = Math.max(COOLDOWN_MS, Number(explicitMs) || 0);
  inMemoryCooldown.set(accountId, Date.now() + ms);
}

// Best-effort — a failed write here should never crash the generation job
// that's already reporting the real error via the transcripts row itself.
function markError(accountId, message) {
  supabase.from('groq_accounts').update({ last_error: message }).eq('id', accountId).then(
    () => {},
    () => {}
  );
}

module.exports = { listActive, pick, markRateLimited, markError };
