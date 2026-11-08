'use strict';
// Tiny in-memory stand-in for the supabase-js query builder -- just the
// methods the subscription routes use. Lets the route tests run without a DB.
let seq = 0;
const uuid = () => {
  seq++;
  const h = seq.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${h}`;
};

// Mirrors the generated columns name_key / title_key in migration_centralized_artwork.sql.
const keyOf = (v) => String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

function create() {
  const db = { app_users: [], subscriptions: [], subscription_history: [], user_notifications: [], trial_claims: [], admin_activity_log: [], user_devices: [], albums: [], story_series: [], media_items: [], content_labels: [], storage_accounts: [], story_follows: [] };

  const overview = () =>
    db.app_users.filter((u) => u.role === 'listener').map((u) => {
      const s = db.subscriptions.find((x) => x.user_id === u.id);
      return {
        user_id: u.id, email: u.email, display_name: u.display_name, account_status: u.status, joined_at: u.created_at,
        subscription_id: s?.id ?? null, is_lifetime: s?.is_lifetime ?? null, start_date: s?.start_date ?? null,
        end_date: s?.end_date ?? null, note: s?.note ?? null, subscription_updated_at: s?.updated_at ?? null,
        plan: s?.plan ?? null, is_trial: s?.is_trial ?? false, expires_at: s?.expires_at ?? null,
        device_limit: u.device_limit ?? 1, device_count: db.user_devices.filter((d) => d.user_id === u.id && d.status === 'active').length,
      };
    });
  const source = (t) => (t === 'user_subscription_overview' ? overview() : db[t]);

  function from(table) {
    let op = 'select';
    let payload;
    let opts = {};
    let head = false;
    let wantCount = false;
    let returning = false;
    const filters = [];
    const orders = [];
    let rng = null;
    let lim = null;
    let single = null;

    const b = {
      select(_cols, o = {}) { if (op === 'select') op = 'select'; else returning = true; if (o.count) wantCount = true; if (o.head) head = true; return b; },
      insert(p) { op = 'insert'; payload = p; return b; },
      update(p) { op = 'update'; payload = p; return b; },
      upsert(p, o) { op = 'upsert'; payload = p; opts = o || {}; return b; },
      delete() { op = 'delete'; return b; },
      eq: (c, v) => (filters.push((r) => r[c] === v), b),
      neq: (c, v) => (filters.push((r) => r[c] != null && r[c] !== v), b),
      ilike: (c, pat) => {
        const re = new RegExp('^' + pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$', 'i');
        filters.push((r) => r[c] != null && re.test(String(r[c])));
        return b;
      },
      is: (c, v) => (filters.push((r) => (v === null ? r[c] === null || r[c] === undefined : r[c] === v)), b),
      not: (c, o, v) => (filters.push((r) => !(o === 'is' && v === null ? r[c] === null || r[c] === undefined : false)), b),
      gt: (c, v) => (filters.push((r) => r[c] != null && r[c] > v), b),
      gte: (c, v) => (filters.push((r) => r[c] != null && r[c] >= v), b),
      lt: (c, v) => (filters.push((r) => r[c] != null && r[c] < v), b),
      lte: (c, v) => (filters.push((r) => r[c] != null && r[c] <= v), b),
      in: (c, vs) => (filters.push((r) => vs.includes(r[c])), b),
      or(expr) {
        const parts = expr.split(',').map((p) => { const [col, op, ...rest] = p.split('.'); return [col, op, rest.join('.')]; });
        const test = (r, [c, op, v]) => {
          const x = r[c];
          if (op === 'ilike') return String(x ?? '').toLowerCase().includes(v.replace(/%/g, '').toLowerCase());
          if (x == null) return false;
          return { eq: x === v, lt: x < v, lte: x <= v, gt: x > v, gte: x >= v }[op];
        };
        filters.push((r) => parts.some((pt) => test(r, pt)));
        return b;
      },
      order(c, o = {}) { orders.push([c, o.ascending !== false]); return b; },
      range(a, z) { rng = [a, z]; return b; },
      limit(n) { lim = n; return b; },
      single() { single = 'single'; return b; },
      maybeSingle() { single = 'maybe'; return b; },
      then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); },
    };

    function run() {
      const match = (r) => filters.every((f) => f(r));
      if (op === 'insert' || op === 'upsert') {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((p) => ({
          id: uuid(), created_at: new Date().toISOString(), ...(table === 'user_notifications' ? { read_at: null } : {}), ...p,
        }));
        const inserted = [];
        for (const r of rows) {
          if (table === 'user_notifications' && r.dedupe_key && db[table].some((x) => x.dedupe_key === r.dedupe_key)) {
            if (op === 'upsert' && opts.ignoreDuplicates) continue;
            return { data: null, error: { message: 'duplicate key' } };
          }
          if (table === 'subscriptions' && db[table].some((x) => x.user_id === r.user_id)) {
            return { data: null, error: { message: 'duplicate key (user_id)' } };
          }
          if (table === 'albums') {
            r.name_key = keyOf(r.name);
            r.release_year = r.release_year ?? null;
            if (db.albums.some((x) => x.name_key === r.name_key && (x.release_year ?? 0) === (r.release_year ?? 0))) {
              return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "albums_name_year_uniq"' } };
            }
          }
          if (table === 'story_series') {
            r.title_key = keyOf(r.title);
            if (db.story_series.some((x) => x.title_key === r.title_key)) {
              return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "story_series_title_key_uniq"' } };
            }
          }
          db[table].push(r);
          inserted.push(r);
        }
        return shape(inserted, true);
      }
      if (op === 'update') {
        const hit = db[table].filter(match);
        if (table === 'albums' && 'name' in payload) {
          const key = keyOf(payload.name);
          const year = 'release_year' in payload ? payload.release_year : undefined;
          for (const r of hit) {
            const y = year === undefined ? r.release_year : year;
            if (db.albums.some((x) => x !== r && x.name_key === key && (x.release_year ?? 0) === (y ?? 0))) {
              return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "albums_name_year_uniq"' } };
            }
          }
        }
        hit.forEach((r) => {
          Object.assign(r, payload);
          if (table === 'albums' && 'name' in payload) r.name_key = keyOf(r.name);
          if (table === 'story_series' && 'title' in payload) r.title_key = keyOf(r.title);
        });
        return shape(hit, returning);
      }
      if (op === 'delete') {
        const keep = db[table].filter((r) => !match(r));
        db[table].length = 0; db[table].push(...keep);
        return { data: null, error: null };
      }
      let rows = source(table).filter(match);
      const total = rows.length;
      for (const [c, asc] of [...orders].reverse()) {
        rows = [...rows].sort((a, z) => (a[c] === z[c] ? 0 : (a[c] ?? '') > (z[c] ?? '') ? 1 : -1) * (asc ? 1 : -1));
      }
      if (rng) rows = rows.slice(rng[0], rng[1] + 1);
      if (lim != null) rows = rows.slice(0, lim);
      if (head) return { data: null, error: null, count: total };
      return { ...shape(rows, true), count: wantCount ? total : null };
    }

    function shape(rows, ret) {
      if (!ret) return { data: null, error: null };
      rows = rows.map((r) => ({ ...r })); // real PostgREST returns copies, never live row references
      if (single) {
        if (rows.length === 0) return single === 'maybe' ? { data: null, error: null } : { data: null, error: { message: 'no rows' } };
        return { data: rows[0], error: null };
      }
      return { data: rows, error: null };
    }
    return b;
  }

  return { from, db, uuid };
}
module.exports = { create };
