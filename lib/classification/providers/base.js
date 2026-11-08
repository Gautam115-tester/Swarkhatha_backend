'use strict';

/**
 * Shared plumbing for the metadata providers: a typed error, a serial rate
 * limiter, a circuit breaker and the wrapper that applies timeout + breaker +
 * health counters around every provider lookup.
 */

class ProviderError extends Error {
  /** kind: 'rate_limited' | 'unavailable' | 'auth' | 'forbidden' | 'bad_response' | 'timeout' */
  constructor(provider, kind, message, { retryable = true, retryAfterMs = 0, status } = {}) {
    super(`[${provider}] ${message}`);
    this.name = 'ProviderError';
    this.provider = provider;
    this.kind = kind;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.status = status;
  }
}

/** Converts an axios-style failure into a ProviderError (never leaks request headers/keys into the message). */
function fromHttpError(provider, err) {
  if (err instanceof ProviderError) return err;
  const status = err?.response?.status;
  if (status === 429) {
    const ra = Number(err.response.headers?.['retry-after']);
    return new ProviderError(provider, 'rate_limited', 'rate limited (HTTP 429)', { retryAfterMs: Number.isFinite(ra) ? ra * 1000 : 60000, status });
  }
  if (status === 503) {
    const ra = Number(err.response.headers?.['retry-after']);
    return new ProviderError(provider, 'rate_limited', 'service busy (HTTP 503)', { retryAfterMs: Number.isFinite(ra) ? ra * 1000 : 30000, status });
  }
  if (status === 401) return new ProviderError(provider, 'auth', 'credentials rejected (HTTP 401)', { retryable: false, status });
  if (status === 403) return new ProviderError(provider, 'forbidden', 'access forbidden (HTTP 403)', { retryable: false, status });
  if (status >= 500) return new ProviderError(provider, 'unavailable', `server error (HTTP ${status})`, { status });
  if (status >= 400) return new ProviderError(provider, 'bad_response', `request rejected (HTTP ${status})`, { retryable: false, status });
  if (err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT') return new ProviderError(provider, 'timeout', 'request timed out');
  return new ProviderError(provider, 'unavailable', `network error: ${err?.code || err?.message || 'unknown'}`);
}

/** Serial scheduler with a minimum gap between the START of consecutive calls. */
function createLimiter(minIntervalMs, { now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let chain = Promise.resolve();
  let nextAt = 0;
  return {
    schedule(fn) {
      const run = chain.then(async () => {
        const wait = nextAt - now();
        if (wait > 0) await sleep(wait);
        nextAt = now() + minIntervalMs;
        return fn();
      });
      chain = run.catch(() => {}); // a failed call must not poison the queue
      return run;
    },
    // Pushes the next call back (e.g. after a 429 with Retry-After).
    delay(ms) { nextAt = Math.max(nextAt, now() + ms); }
  };
}

/** Opens after `failures` consecutive retryable failures; closed again after `cooldownMs`. */
function createBreaker({ failures = 5, cooldownMs = 120000, now = Date.now } = {}) {
  const state = new Map(); // provider -> { n, openUntil }
  const get = (p) => { if (!state.has(p)) state.set(p, { n: 0, openUntil: 0, fatal: false }); return state.get(p); };
  return {
    isOpen(p) { return get(p).openUntil > now(); },
    openUntil(p) { return get(p).openUntil; },
    // true while the pause was caused by a permanent problem (rejected/missing credentials), not an outage
    isFatal(p) { const s = get(p); return s.fatal && s.openUntil > now(); },
    success(p) { const s = get(p); s.n = 0; s.openUntil = 0; s.fatal = false; },
    failure(p, { fatal = false, retryAfterMs = 0 } = {}) {
      const s = get(p);
      s.n += 1;
      if (fatal) { s.fatal = true; s.openUntil = now() + Math.max(cooldownMs, 10 * 60 * 1000); } // bad credentials: don't hammer
      else if (retryAfterMs) s.openUntil = Math.max(s.openUntil, now() + retryAfterMs);
      else if (s.n >= failures) s.openUntil = now() + cooldownMs;
    }
  };
}

function withTimeout(promise, ms, provider) {
  let timer;
  const t = new Promise((_, reject) => { timer = setTimeout(() => reject(new ProviderError(provider, 'timeout', `timed out after ${ms}ms`)), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

/**
 * Runs one provider lookup. Never throws: returns { provider, ok, skipped?, error?, result? }
 * so one provider failing can never fail the others (or the job).
 */
async function runProvider(provider, track, ctx) {
  const name = provider.name;
  const { breaker, stats, log, config } = ctx;
  if (breaker.isOpen(name)) {
    const fatal = breaker.isFatal(name);
    return { provider: name, ok: false, skipped: true, error: new ProviderError(name, fatal ? 'auth' : 'unavailable', fatal ? 'paused: not configured or credentials rejected' : 'temporarily paused after repeated failures', { retryable: !fatal, retryAfterMs: fatal ? 0 : Math.max(0, breaker.openUntil(name) - Date.now()) }) };
  }
  try {
    const result = await withTimeout(provider.lookup(track, ctx), provider.timeoutMs || config.providers.timeoutMs, name);
    breaker.success(name);
    stats.record(name, 'ok');
    return { provider: name, ok: true, result };
  } catch (e) {
    const err = e instanceof ProviderError ? e : fromHttpError(name, e);
    breaker.failure(name, { fatal: err.kind === 'auth' || err.kind === 'forbidden', retryAfterMs: err.kind === 'rate_limited' ? err.retryAfterMs : 0 });
    stats.record(name, err.kind === 'rate_limited' ? 'rate_limited' : 'failed', err.message);
    log('warn', 'provider_failed', { provider: name, kind: err.kind, message: err.message, trackId: track.id });
    return { provider: name, ok: false, error: err };
  }
}

/** p scaled by how sure we are this provider record IS this recording. */
const scaled = (reliability, strength, matchFactor = 1) => Math.max(0, Math.min(0.99, reliability * strength * matchFactor));

/** Keeps the highest p per key. */
function dedupe(observations) {
  const best = new Map();
  for (const o of observations) {
    const k = `${o.key}|${o.scope || 'recording'}`;
    if (!best.has(k) || best.get(k).p < o.p) best.set(k, o);
  }
  return [...best.values()];
}

module.exports = { ProviderError, fromHttpError, createLimiter, createBreaker, withTimeout, runProvider, scaled, dedupe };
