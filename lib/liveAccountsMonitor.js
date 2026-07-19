const EventEmitter = require('events');
const supabase = require('./supabaseClient');
const { decrypt } = require('./crypto');
const drime = require('./drime');

/**
 * Keeps an in-memory, always-fresh snapshot of every active Drime
 * storage account's storage usage, refreshed on a background timer, and
 * lets routes/clients read it instantly instead of hitting Drime on
 * every request.
 *
 * The timer only runs while >=1 admin app has the live stream open —
 * see acquire()/release(), called from the `/accounts/live` SSE route
 * in routes/storage.js on connect/disconnect. No admin app open means
 * no Drime traffic; the moment the first one connects the poll starts,
 * and it stops the moment the last one disconnects.
 *
 * WHY NOT hit Drime every second per client:
 * GET /user/space-usage is a real network round trip per account, and
 * doing that every second — multiplied by every admin dashboard that's
 * open — risks hitting Drime's rate limits or looking like abuse on the
 * account. Instead this module polls Drime itself on one shared
 * interval (REFRESH_INTERVAL_MS, default 8s — comfortably safe, still
 * feels current), and the SSE stream in routes/storage.js pushes that
 * cached snapshot to connected admins every second so the UI *looks*
 * and feels live/continuously updating even though the underlying Drime
 * calls happen far less often. Lower REFRESH_INTERVAL_MS via env if you
 * want tighter freshness and are comfortable with more Drime traffic.
 */
const REFRESH_INTERVAL_MS = Number(process.env.STORAGE_REFRESH_INTERVAL_MS || 8000);

class LiveAccountsMonitor extends EventEmitter {
  constructor() {
    super();
    this.snapshot = []; // last known array of account stat objects
    this.refreshing = false;
    this._timer = null;
    this._listenerCount = 0; // how many admin app connections currently want live updates
  }

  /**
   * Reference-counted start/stop: the 8s Drime poll should only run
   * while at least one admin app actually has the storage screen's SSE
   * connection open (see routes/storage.js `/accounts/live`), not for
   * the whole lifetime of the server. Each connected admin calls
   * acquire() on connect and release() on disconnect; the timer only
   * runs while the count is > 0, and multiple admins connected at once
   * still share the single underlying timer/Drime calls.
   */
  acquire() {
    this._listenerCount++;
    if (this._listenerCount === 1) this.start();
    return this._listenerCount;
  }

  release() {
    this._listenerCount = Math.max(0, this._listenerCount - 1);
    if (this._listenerCount === 0) this.stop();
    return this._listenerCount;
  }

  start() {
    if (this._timer) return;
    this.refreshAll(); // fire immediately so the cache isn't stale from before the last admin closed the app
    this._timer = setInterval(() => this.refreshAll(), REFRESH_INTERVAL_MS);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  getSnapshot() {
    return this.snapshot;
  }

  async refreshOne(acct) {
    try {
      const creds = JSON.parse(decrypt(acct.credentials_enc));
      const usage = await drime.getSpaceUsage({ accessToken: creds.accessToken });

      return {
        id: acct.id,
        label: acct.label,
        provider: 'drime',
        purpose: acct.purpose,
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

  async refreshAll() {
    if (this.refreshing) return; // don't overlap cycles if one runs long
    this.refreshing = true;
    try {
      const { data: accounts, error } = await supabase
        .from('storage_accounts').select('*').eq('is_active', true);
      if (error || !accounts) return;

      const results = await Promise.all(accounts.map((a) => this.refreshOne(a)));
      this.snapshot = results.sort((a, b) => (b.freeBytes || 0) - (a.freeBytes || 0));

      // Persist the latest known numbers so a cold-started server (or
      // the one-shot GET /accounts fallback) still has something
      // recent even before the first refresh cycle completes.
      await Promise.all(results.map((r) => {
        if (r.status !== 'ok') return Promise.resolve();
        return supabase.from('storage_accounts').update({
          last_known_free_bytes: r.freeBytes,
          last_known_used_bytes: r.usedBytes,
          last_known_total_bytes: r.totalBytes,
          last_checked_at: r.checkedAt
        }).eq('id', r.id);
      }));

      this.emit('update', this.snapshot);
    } finally {
      this.refreshing = false;
    }
  }
}

module.exports = new LiveAccountsMonitor();
