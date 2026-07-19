const EventEmitter = require('events');
const supabase = require('./supabaseClient');
const { decrypt } = require('./crypto');
const mediafire = require('./mediafire');

/**
 * Keeps an in-memory, always-fresh snapshot of every active MediaFire
 * storage account's storage + bandwidth, refreshed on a background
 * timer, and lets routes/clients read it instantly instead of hitting
 * MediaFire on every request.
 *
 * WHY NOT hit MediaFire every second per client:
 * MediaFire login + get_info is a real network round trip per account,
 * and doing that every second — multiplied by every admin dashboard
 * that's open — risks hitting MediaFire's rate limits or looking like
 * abuse on the account. Instead this module polls MediaFire itself on
 * one shared interval (REFRESH_INTERVAL_MS, default 8s — comfortably
 * safe, still feels current), and the SSE stream in routes/storage.js
 * pushes that cached snapshot to connected admins every second so the
 * UI *looks* and feels live/continuously updating even though the
 * underlying MediaFire calls happen far less often. Lower
 * REFRESH_INTERVAL_MS via env if you want tighter freshness and are
 * comfortable with more MediaFire traffic.
 */
const REFRESH_INTERVAL_MS = Number(process.env.STORAGE_REFRESH_INTERVAL_MS || 8000);

class LiveAccountsMonitor extends EventEmitter {
  constructor() {
    super();
    this.snapshot = []; // last known array of account stat objects
    this.refreshing = false;
    this._timer = null;
  }

  start() {
    if (this._timer) return;
    this.refreshAll(); // fire immediately so the cache isn't empty on boot
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
      const session = await mediafire.getSessionToken({
        email: creds.email, password: creds.password, appId: creds.appId, apiKey: creds.apiKey
      });
      const info = await mediafire.getAccountInfo({ sessionToken: session.sessionToken });
      const freeBytes = info.limitBytes - info.usedBytes;

      return {
        id: acct.id,
        label: acct.label,
        provider: 'mediafire',
        purpose: acct.purpose,
        status: 'ok',
        freeBytes,
        freeGB: (freeBytes / 1e9).toFixed(2),
        usedBytes: info.usedBytes,
        totalBytes: info.limitBytes,
        isPremium: info.isPremium,
        bandwidthRemainingBytes: info.bandwidthRemainingBytes,
        bandwidthTotalBytes: info.bandwidthTotalBytes,
        bandwidthRemainingGB: info.bandwidthRemainingBytes != null
          ? (info.bandwidthRemainingBytes / 1e9).toFixed(2) : null,
        checkedAt: new Date().toISOString()
      };
    } catch (e) {
      return {
        id: acct.id, label: acct.label, provider: 'mediafire', purpose: acct.purpose,
        status: 'error',
        error: e.response?.data?.message || e.response?.data?.response?.message || e.message,
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
          last_known_bandwidth_remaining_bytes: r.bandwidthRemainingBytes,
          is_premium: r.isPremium,
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
