'use strict';

/**
 * Cache for external-metadata lookups, in two layers: a small in-process LRU and the
 * shared music_provider_cache table (so a restart, or a second instance, does not
 * repeat API calls). "Nothing found" is cached too, with a shorter lifetime, so a
 * library full of obscure tracks does not hammer a provider with the same miss.
 *
 * The cache is an optimisation: if the table is missing or the database errors,
 * lookups still work, they just are not cached durably.
 */
function createCache({ supabase, config, now = Date.now }) {
  const mem = new Map(); // `${provider}|${key}` -> { found, payload, exp }
  const inflight = new Map();
  let dbDisabled = false;
  const { ttlMs, negativeTtlMs, memoryEntries } = config.cache;

  const memGet = (k) => {
    const e = mem.get(k);
    if (!e) return undefined;
    if (e.exp < now()) { mem.delete(k); return undefined; }
    mem.delete(k); mem.set(k, e); // LRU refresh
    return e;
  };
  const memSet = (k, e) => {
    mem.delete(k); mem.set(k, e);
    while (mem.size > memoryEntries) mem.delete(mem.keys().next().value);
  };

  async function dbGet(provider, key) {
    if (dbDisabled || !supabase) return undefined;
    try {
      const { data, error } = await supabase.from('music_provider_cache')
        .select('found, payload, expires_at').eq('provider', provider).eq('cache_key', key).maybeSingle();
      if (error) { if (/does not exist|schema cache/i.test(error.message || '')) dbDisabled = true; return undefined; }
      if (!data || new Date(data.expires_at).getTime() < now()) return undefined;
      return { found: data.found, payload: data.payload, exp: new Date(data.expires_at).getTime() };
    } catch (_) { return undefined; }
  }

  async function dbSet(provider, key, found, payload, expMs) {
    if (dbDisabled || !supabase) return;
    try {
      // Select-then-write rather than upsert: also behaves under the in-memory test double.
      const row = { provider, cache_key: key, found, payload: found ? payload : null, fetched_at: new Date(now()).toISOString(), expires_at: new Date(expMs).toISOString() };
      const { data } = await supabase.from('music_provider_cache').select('cache_key').eq('provider', provider).eq('cache_key', key).maybeSingle();
      const { error } = data
        ? await supabase.from('music_provider_cache').update(row).eq('provider', provider).eq('cache_key', key)
        : await supabase.from('music_provider_cache').insert(row);
      if (error && /does not exist|schema cache/i.test(error.message || '')) dbDisabled = true;
    } catch (_) { /* cache write is best-effort */ }
  }

  /**
   * fetchFn() resolves to a payload, or null/undefined meaning "provider has nothing".
   * If it throws, nothing is cached and the error propagates.
   */
  async function getOrFetch(provider, key, fetchFn) {
    const k = `${provider}|${key}`;
    const hit = memGet(k) || await dbGet(provider, key);
    if (hit) { memSet(k, hit); return { payload: hit.found ? hit.payload : null, cached: true }; }

    if (!inflight.has(k)) {
      inflight.set(k, (async () => {
        const payload = await fetchFn();
        const found = payload !== null && payload !== undefined;
        const exp = now() + (found ? ttlMs : negativeTtlMs);
        memSet(k, { found, payload: found ? payload : null, exp });
        await dbSet(provider, key, found, payload, exp);
        return found ? payload : null;
      })().finally(() => inflight.delete(k)));
    }
    return { payload: await inflight.get(k), cached: false };
  }

  return { getOrFetch, _mem: mem };
}

module.exports = { createCache };
