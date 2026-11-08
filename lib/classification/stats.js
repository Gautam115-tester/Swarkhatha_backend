'use strict';

/** Provider health counters: persisted daily via an RPC, mirrored in memory. Never throws. */
function createStats({ supabase }) {
  const memory = {};
  let rpcDisabled = false;
  return {
    record(provider, outcome, error) {
      const m = (memory[provider] ||= { ok: 0, failed: 0, rate_limited: 0, last_error: null });
      m[outcome] = (m[outcome] || 0) + 1;
      if (outcome !== 'ok') m.last_error = String(error || '').slice(0, 300);
      if (rpcDisabled || !supabase?.rpc) return;
      Promise.resolve(supabase.rpc('classification_record_provider_call', { p_provider: provider, p_outcome: outcome, p_error: error ? String(error).slice(0, 500) : null }))
        .then((r) => { if (r?.error && /does not exist|schema cache|Could not find/i.test(r.error.message || '')) rpcDisabled = true; }, () => {});
    },
    snapshot: () => JSON.parse(JSON.stringify(memory))
  };
}

module.exports = { createStats };
