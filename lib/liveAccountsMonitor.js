const EventEmitter = require('events');
const supabase = require('./supabaseClient');
const { decrypt } = require('./crypto');
const drime = require('./drime');

/**
 * Keeps an in-memory snapshot of every active Drime storage account's
 * usage and refreshes it on a schedule that depends on whether an admin
 * is looking:
 *
 *   ADMIN APP OPEN    -> every FAST_MS (default 30 s)
 *   ADMIN APP CLOSED  -> every BACKGROUND_MS (default 25 min)
 *
 * "Open" means at least one admin app holds the /accounts/live SSE
 * stream (acquire()/release()), or has hit GET /accounts recently
 * (touch(), which covers the polling fallback the app uses when SSE is
 * blocked). The fast timer starts the moment the first admin connects
 * and stops once the last one is gone and the lease has lapsed.
 *
 * THE CACHE (what happens when an admin opens the app)
 *   1. The snapshot is served immediately — from memory if the server
 *      is warm, otherwise hydrated from storage_accounts.last_known_*
 *      (hydrate()), so a freshly woken Render instance never starts empty.
 *   2. Drime is only called straight away if that snapshot is OLDER than
 *      FAST_MS. If the background job refreshed it 10 s ago, opening the
 *      app costs zero Drime calls and the first fast refresh lands 20 s
 *      later, keeping a steady 30 s rhythm.
 *   3. Overlapping refreshes share one in-flight promise.
 *
 * RENDER FREE TIER: an in-process timer cannot fire while the instance is
 * asleep (it sleeps after ~15 min without inbound traffic). The
 * background timer below covers always-on instances; for free tier,
 * something external must call POST /api/storage/accounts/background-check
 * every 20-30 min (see cdn-worker/storage-check-cron-worker.js).
 */
const FAST_MS = Number(process.env.STORAGE_REFRESH_INTERVAL_MS || 30 * 1000);
const BACKGROUND_MS = Number(process.env.STORAGE_BACKGROUND_INTERVAL_MS || 25 * 60 * 1000);
// GET /accounts (the SSE-blocked fallback) keeps the fast timer alive this long.
const LEASE_MS = Number(process.env.STORAGE_ACTIVE_LEASE_MS || 90 * 1000);
// Don't write unchanged numbers to Supabase on every tick.
const PERSIST_HEARTBEAT_MS = 10 * 60 * 1000;

class LiveAccountsMonitor extends EventEmitter {
  constructor() {
    super();
    this.FAST_MS = FAST_MS;
    this.BACKGROUND_MS = BACKGROUND_MS;
    this.snapshot = [];
    this.lastRefreshAt = 0; // ms epoch of the last successful full refresh
    this._inflight = null;
    this._listenerCount = 0;
    this._leaseUntil = 0;
    this._fastTimer = null;
    this._bgTimer = null;
    this._hydrated = null;
    this._lastPersisted = new Map(); // id -> { key, at }
  }

  /* ---------------- activity tracking ---------------- */

  isActive() {
    return this._listenerCount > 0 || Date.now() < this._leaseUntil;
  }

  acquire() {
    this._listenerCount++;
    this._syncTimers();
    return this._listenerCount;
  }

  release() {
    this._listenerCount = Math.max(0, this._listenerCount - 1);
    this._syncTimers();
    return this._listenerCount;
  }

  /** An admin client was seen over plain HTTP — treat the app as open for LEASE_MS. */
  touch() {
    this._leaseUntil = Date.now() + LEASE_MS;
    this._syncTimers();
  }

  /* ---------------- scheduling ---------------- */

  /** Call once at boot: loads the cached numbers and arms the background timer. */
  async init() {
    await this.hydrate();
    this._syncTimers();
  }

  _syncTimers() {
    if (this.isActive()) {
      this._clearBg();
      if (!this._fastTimer) this._scheduleFast(Math.max(0, FAST_MS - this.ageMs()));
    } else {
      this._clearFast();
      if (!this._bgTimer) this._scheduleBg(Math.max(0, BACKGROUND_MS - this.ageMs()));
    }
  }

  _scheduleFast(delay) {
    this._fastTimer = setTimeout(async () => {
      this._fastTimer = null;
      if (!this.isActive()) return this._syncTimers(); // lease lapsed / last admin left
      await this.refreshAll();
      this._syncTimers(); // reschedules a full FAST_MS from now (or flips to background)
    }, delay);
  }

  _scheduleBg(delay) {
    this._bgTimer = setTimeout(async () => {
      this._bgTimer = null;
      if (this.isActive()) return this._syncTimers();
      await this.refreshAll();
      this._syncTimers();
    }, delay);
    this._bgTimer.unref?.(); // never keep the process alive just for this
  }

  _clearFast() { if (this._fastTimer) clearTimeout(this._fastTimer); this._fastTimer = null; }
  _clearBg() { if (this._bgTimer) clearTimeout(this._bgTimer); this._bgTimer = null; }

  /* ---------------- cache ---------------- */

  ageMs() {
    return this.lastRefreshAt ? Date.now() - this.lastRefreshAt : Infinity;
  }

  getSnapshot() {
    return this.snapshot;
  }

  /** Load last_known_* from Supabase once, so a cold server has data to serve immediately. */
  hydrate() {
    if (this._hydrated) return this._hydrated;
    this._hydrated = (async () => {
      try {
        const { data, error } = await supabase.from('storage_accounts').select('*').eq('is_active', true);
        if (error || !data || this.snapshot.length > 0) return;
        let oldest = Infinity;
        this.snapshot = data.map((a) => {
          const checked = a.last_checked_at ? Date.parse(a.last_checked_at) : 0;
          oldest = Math.min(oldest, checked);
          const hasData = a.last_known_free_bytes != null;
          return {
            id: a.id, label: a.label, provider: 'drime', purpose: a.purpose,
            status: hasData ? 'ok' : 'error',
            ...(hasData ? {
              freeBytes: Number(a.last_known_free_bytes),
              freeGB: (Number(a.last_known_free_bytes) / 1e9).toFixed(2),
              usedBytes: a.last_known_used_bytes != null ? Number(a.last_known_used_bytes) : undefined,
              totalBytes: a.last_known_total_bytes != null ? Number(a.last_known_total_bytes) : undefined,
            } : { error: 'Not checked yet' }),
            checkedAt: a.last_checked_at || null,
            fromCache: true
          };
        }).sort((x, y) => (y.freeBytes || 0) - (x.freeBytes || 0));
        // Oldest account decides freshness: one never-checked account => stale.
        this.lastRefreshAt = Number.isFinite(oldest) ? oldest : 0;
      } catch (e) {
        console.error('[liveMonitor] hydrate failed:', e.message);
      }
    })();
    return this._hydrated;
  }

  /** Refresh only if the cache is older than maxAgeMs; otherwise a no-op. */
  async refreshIfStale(maxAgeMs) {
    await this.hydrate();
    if (this.ageMs() < maxAgeMs) return { refreshed: false, ageMs: this.ageMs() };
    await this.refreshAll();
    return { refreshed: true, ageMs: this.ageMs() };
  }

  /* ---------------- Drime ---------------- */

  async refreshOne(acct) {
    try {
      const creds = JSON.parse(decrypt(acct.credentials_enc));
      const usage = await drime.getSpaceUsage({ accessToken: creds.accessToken });
      return {
        id: acct.id, label: acct.label, provider: 'drime', purpose: acct.purpose,
        status: 'ok',
        freeBytes: usage.availableBytes,
        freeGB: (usage.availableBytes / 1e9).toFixed(2),
        usedBytes: usage.usedBytes,
        totalBytes: usage.limitBytes,
        checkedAt: new Date().toISOString()
      };
    } catch (e) {
      return {
        id: acct.id, label: acct.label, provider: 'drime', purpose: acct.purpose,
        status: 'error',
        error: e.response?.data?.message || e.message,
        checkedAt: new Date().toISOString()
      };
    }
  }

  /** Shares one in-flight refresh between all callers (timer, SSE connect, ?force=true, cron). */
  refreshAll() {
    if (this._inflight) return this._inflight;
    this._inflight = this._doRefresh().finally(() => { this._inflight = null; });
    return this._inflight;
  }

  async _doRefresh() {
    try {
      const { data: accounts, error } = await supabase
        .from('storage_accounts').select('*').eq('is_active', true);
      if (error || !accounts) return this.snapshot;

      const results = await Promise.all(accounts.map((a) => this.refreshOne(a)));
      this.snapshot = results.sort((a, b) => (b.freeBytes || 0) - (a.freeBytes || 0));
      this.lastRefreshAt = Date.now();

      await this._persist(results);
      this.emit('update', this.snapshot);
      return this.snapshot;
    } catch (e) {
      console.error('[liveMonitor] refresh failed:', e.message);
      return this.snapshot;
    }
  }

  // Writes last_known_* only when numbers changed (or every PERSIST_HEARTBEAT_MS
  // so last_checked_at still advances). At a 30 s cadence most ticks are no-ops.
  async _persist(results) {
    const now = Date.now();
    await Promise.all(results.map((r) => {
      if (r.status !== 'ok') return null;
      const key = `${r.freeBytes}:${r.usedBytes}:${r.totalBytes}`;
      const prev = this._lastPersisted.get(r.id);
      if (prev && prev.key === key && now - prev.at < PERSIST_HEARTBEAT_MS) return null;
      this._lastPersisted.set(r.id, { key, at: now });
      return supabase.from('storage_accounts').update({
        last_known_free_bytes: r.freeBytes,
        last_known_used_bytes: r.usedBytes,
        last_known_total_bytes: r.totalBytes,
        last_checked_at: r.checkedAt
      }).eq('id', r.id);
    }).filter(Boolean));
  }
}

module.exports = new LiveAccountsMonitor();
