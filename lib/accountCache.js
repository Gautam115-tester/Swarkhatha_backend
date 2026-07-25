/**
 * Short-lived in-memory cache for storage_accounts rows, keyed by id.
 *
 * The public cover-image proxy (GET /api/storage/cover/:accountId/:hash)
 * used to run a fresh Supabase lookup on EVERY single image request —
 * with millions of images across thousands of users, that's a database
 * round trip purely to re-discover the same handful of 'image'-purpose
 * accounts' credentials and purpose flag, over and over, for images that
 * never change owner. Those rows only change when an admin adds, edits,
 * or removes a storage account (rare), so a short TTL cache removes that
 * round trip for the overwhelmingly common case.
 *
 * TTL (not "forever") because purpose/is_active can be edited from the
 * admin app's Storage screen, and the public cover route's whole
 * authorization check IS `purpose === 'image' && is_active` — a stale
 * cache here has a real (if narrow) consistency implication. PATCH
 * /accounts/:id in routes/storage.js also explicitly invalidates below
 * so edits take effect immediately rather than waiting out the TTL.
 */

const supabase = require('./supabaseClient');

const TTL_MS = Number(process.env.STORAGE_ACCOUNT_CACHE_TTL_MS || 5 * 60 * 1000); // 5 min

const cache = new Map(); // id -> { row, expiresAt }

async function getAccount(id) {
  const hit = cache.get(id);
  if (hit && hit.expiresAt > Date.now()) return hit.row;

  const { data, error } = await supabase.from('storage_accounts').select('*').eq('id', id).single();
  if (error || !data) {
    cache.delete(id);
    return null;
  }
  cache.set(id, { row: data, expiresAt: Date.now() + TTL_MS });
  return data;
}

function invalidate(id) {
  cache.delete(id);
}

module.exports = { getAccount, invalidate };
