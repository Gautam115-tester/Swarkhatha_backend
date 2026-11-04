'use strict';
/**
 * End-to-end tests for trials, devices, enforcement and the admin dashboard
 * API. These run the REAL route modules with the REAL supabase-js client
 * against a REAL Postgres (through PostgREST), so the SQL functions, unique
 * constraints, advisory locks and PostgREST filters are exercised for real --
 * the in-memory fake used by the other suites can't prove any of that.
 *
 * Skipped unless SK_INTEGRATION=1. See test/integration/README.md.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const ENABLED = process.env.SK_INTEGRATION === '1';
if (!ENABLED) {
  test('integration suite (skipped: set SK_INTEGRATION=1, see test/integration/README.md)', { skip: true }, () => {});
  return;
}

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:3200';
process.env.JWT_SECRET = 'it-jwt-secret';
process.env.DEVICE_HASH_SECRET = 'it-device-secret';
process.env.TOKEN_ENC_KEY = process.env.TOKEN_ENC_KEY || 'a'.repeat(64);
process.env.SUBSCRIPTION_TZ = 'Asia/Kolkata';
process.env.DEVICE_CHECK_TTL_MS = '0'; // deterministic: every request re-checks
process.env.ENTITLEMENT_CACHE_TTL_MS = '0';
process.env.SUBSCRIPTION_CRON_SECRET = 'cron-secret';
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  jwt.sign({ role: 'service_role' }, process.env.PGRST_JWT_SECRET || 'super-secret-jwt-token-with-at-least-32-characters-long');

// Per-IP limiters would 429 a test that logs in dozens of times from 127.0.0.1.
const rlPath = require.resolve('../../middleware/rateLimit');
const pass = (req, res, next) => next();
require.cache[rlPath] = {
  id: rlPath, filename: rlPath, loaded: true,
  exports: { authLimiter: pass, mediaLimiter: pass, lyricsLimiter: pass, deviceLimiter: pass, trialLimiter: pass },
};

const supabase = require('../../lib/supabaseClient');
const S = require('../../lib/subscription');
const devicesLib = require('../../lib/devices');
const ent = require('../../middleware/entitlement');
const mailer = require('../../lib/mailer');
mailer.sendSubscriptionEmail = async () => {};

let server;
let base;
let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../../routes/auth'));
  app.use('/api/devices', require('../../routes/devices'));
  app.use('/api/admin', require('../../routes/adminUsers'));
  app.use('/api/storage', ent.deviceGate, require('../../routes/storage'));
  app.use('/api/subscriptions', ent.deviceGate, require('../../routes/subscriptions'));
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
test.beforeEach(() => { devicesLib.clearCache(); ent.clearEntitlementCache(); });

async function api(method, url, token, body) {
  const r = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch (_) { /* empty body */ }
  return { status: r.status, body: json };
}

const PASSWORD = 'Passw0rd!';
async function mkUser(email, { role = 'listener', status = 'approved', limit } = {}) {
  const { data, error } = await supabase.from('app_users').insert({
    email, password_hash: bcrypt.hashSync(PASSWORD, 4), display_name: email.split('@')[0], role, status,
    ...(limit ? { device_limit: limit } : {}),
  }).select().single();
  assert.ifError(error);
  return data;
}
const adminToken = (a) => jwt.sign({ sub: a.id, email: a.email, role: 'admin' }, process.env.JWT_SECRET);

let admin;
test.before(async () => { admin = await mkUser(`admin-${uniq()}@it.test`, { role: 'admin' }); });

// A physical phone. Each call with a new `id` is a different handset.
const hex = (s) => Buffer.from(String(s)).toString('hex').padEnd(32, '0').slice(0, 64);
const phone = (id, o = {}) => ({
  platform: 'android', androidId: `aid${id}`, hardwareId: hex(`drm${id}`), hardwareSignature: hex(`hw${id}`),
  installId: `inst${uniq()}`, manufacturer: 'Samsung', model: 'SM-A546E', osVersion: '14', appVersion: '2.0.0',
  userHandle: 0, cloneReasons: [], secondaryEnv: false, ...o,
});
const login = (email, device) => api('POST', '/api/auth/login', null, { email, password: PASSWORD, ...(device ? { device } : {}) });

// ======================================================= device registration

test('login: listener without device info is refused; admin is never device-bound', async () => {
  const u = await mkUser(`nodev-${uniq()}@it.test`);
  const r = await login(u.email);
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'device_info_required');
  const a = await api('POST', '/api/auth/login', null, { email: admin.email, password: PASSWORD });
  assert.equal(a.status, 200);
  assert.equal(jwt.decode(a.body.token).did, undefined);
});

test('login registers the device and binds the token to it; same phone is recognised, not re-counted', async () => {
  const u = await mkUser(`reg-${uniq()}@it.test`);
  const p = phone('r1');
  const first = await login(u.email, p);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const did = jwt.decode(first.body.token).did;
  assert.ok(did);
  assert.equal(first.body.device.activeCount, 1);

  // logout + login again, reinstall (new installId), clear data (new installId): same slot.
  for (let i = 0; i < 3; i++) {
    const again = await login(u.email, { ...p, installId: `inst${uniq()}` });
    assert.equal(again.status, 200);
    assert.equal(jwt.decode(again.body.token).did, did);
  }
  const { data: rows } = await supabase.from('user_devices').select('*').eq('user_id', u.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].login_count, 4);
  assert.equal(rows[0].install_ids.length, 4); // each reinstall remembered
  // Only keyed hashes are stored -- never the raw identifiers.
  const blob = JSON.stringify(rows[0]);
  assert.ok(!blob.includes('aidr1') && !blob.includes(p.hardwareId));
});

test('limit: a second phone is refused at limit 1, allowed at 2; refusals list the registered devices', async () => {
  const u = await mkUser(`lim-${uniq()}@it.test`);
  assert.equal((await login(u.email, phone('l1'))).status, 200);
  const blocked = await login(u.email, phone('l2'));
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, 'device_limit_reached');
  assert.equal(blocked.body.limit, 1);
  assert.equal(blocked.body.devices.length, 1);

  const ok = await api('PATCH', `/api/admin/users/${u.id}/device-limit`, adminToken(admin), { limit: 2 });
  assert.equal(ok.status, 200);
  assert.equal((await login(u.email, phone('l2'))).status, 200);
  assert.equal((await login(u.email, phone('l3'))).status, 403); // third phone, limit 2
});

test('limit validation: only 1, 2, 3 or 4', async () => {
  const u = await mkUser(`limv-${uniq()}@it.test`);
  for (const bad of [0, 5, '2', 2.5, null, undefined]) {
    assert.equal((await api('PATCH', `/api/admin/users/${u.id}/device-limit`, adminToken(admin), { limit: bad })).status, 400, String(bad));
  }
  for (const good of [1, 2, 3, 4]) {
    assert.equal((await api('PATCH', `/api/admin/users/${u.id}/device-limit`, adminToken(admin), { limit: good })).status, 200);
  }
});

test('concurrency: 12 simultaneous logins from 12 different phones at limit 2 -> exactly 2 succeed', async () => {
  const u = await mkUser(`race-${uniq()}@it.test`, { limit: 2 });
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => login(u.email, phone(`race${i}`))));
  assert.equal(results.filter((r) => r.status === 200).length, 2);
  assert.equal(results.filter((r) => r.body.code === 'device_limit_reached').length, 10);
  const { count } = await supabase.from('user_devices').select('id', { count: 'exact', head: true }).eq('user_id', u.id);
  assert.equal(count, 2);
});

// ------------------------------------------------------------ dual / cloned apps

test('Dual App / second user on the SAME phone is not counted as another device (limit stays 1)', async () => {
  const u = await mkUser(`dual-${uniq()}@it.test`);
  const original = phone('d1');
  const a = await login(u.email, original);
  assert.equal(a.status, 200);

  // The clone: different ANDROID_ID (other Android user), user handle 10, flagged as a
  // secondary environment, no DRM id exposed -- but the SAME hardware signature.
  const clone = phone('d1', { androidId: 'clone-android-id', hardwareId: undefined, userHandle: 10, secondaryEnv: true, cloneReasons: ['secondary_user'] });
  const b = await login(u.email, clone);
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(jwt.decode(b.body.token).did, jwt.decode(a.body.token).did);

  // The clone's own id is now an alias, so it is recognised directly next time.
  const { data: rows } = await supabase.from('user_devices').select('android_id_hashes').eq('user_id', u.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].android_id_hashes.length, 2);
});

test('a DIFFERENT identical phone (same model, no clone flags) is NOT merged', async () => {
  const u = await mkUser(`twin-${uniq()}@it.test`);
  assert.equal((await login(u.email, phone('t1'))).status, 200);
  const twin = phone('t2', { hardwareSignature: hex('hwt1'), hardwareId: undefined }); // same signature, different handset
  const r = await login(u.email, twin);
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'device_limit_reached');
});

test('same phone, Dual App exposes the SAME device-wide DRM id -> one device', async () => {
  const u = await mkUser(`dualdrm-${uniq()}@it.test`);
  const a = await login(u.email, phone('dd1'));
  const clone = phone('dd1', { androidId: 'dd1-clone-aid', userHandle: 10, secondaryEnv: true, cloneReasons: ['secondary_user'] });
  const b = await login(u.email, clone); // same hardwareId (DRM), same signature, different ANDROID_ID
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(jwt.decode(b.body.token).did, jwt.decode(a.body.token).did);
});

test("BYPASS ATTEMPT: friend's identical phone in a Dual App is NOT mistaken for the registered phone", async () => {
  const u = await mkUser(`friend-${uniq()}@it.test`);
  assert.equal((await login(u.email, phone('own1'))).status, 200); // limit 1 used by the owner's phone
  // Same make/model/RAM => same hardware signature; it runs in a Dual App (secondary env);
  // but it is a different handset, so its DRM id and ANDROID_ID differ.
  const friend = phone('own1', {
    androidId: 'friends-phone-aid', hardwareId: hex('friends-phone-drm'),
    userHandle: 10, secondaryEnv: true, cloneReasons: ['secondary_user'],
  });
  const r = await login(u.email, friend);
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'device_limit_reached');
});

test('clone first, original later: still one device', async () => {
  const u = await mkUser(`cloneFirst-${uniq()}@it.test`);
  const clone = phone('c9', { androidId: 'only-clone', hardwareId: undefined, userHandle: 95, secondaryEnv: true, cloneReasons: ['secondary_user'] });
  const a = await login(u.email, clone);
  assert.equal(a.status, 200);
  const original = phone('c9', { hardwareId: undefined });
  const b = await login(u.email, original);
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(jwt.decode(b.body.token).did, jwt.decode(a.body.token).did);
});

test('CLONE_POLICY=block_virtual refuses app-cloner containers but still allows OS dual apps', async () => {
  process.env.CLONE_POLICY = 'block_virtual';
  try {
    const u = await mkUser(`pol-${uniq()}@it.test`, { limit: 4 });
    const virtual = await login(u.email, phone('p1', { secondaryEnv: true, cloneReasons: ['virtual_container'] }));
    assert.equal(virtual.status, 403);
    assert.equal(virtual.body.code, 'clone_blocked');
    const osDual = await login(u.email, phone('p2', { userHandle: 10, secondaryEnv: true, cloneReasons: ['secondary_user'] }));
    assert.equal(osDual.status, 200);
  } finally { delete process.env.CLONE_POLICY; }
});

// ------------------------------------------------- admin device management

async function loggedIn(label, limit = 4) {
  const u = await mkUser(`${label}-${uniq()}@it.test`, { limit });
  const tokens = [];
  for (let i = 0; i < 2; i++) {
    const r = await login(u.email, phone(`${label}${i}`));
    assert.equal(r.status, 200);
    tokens.push(r.body.token);
  }
  return { u, tokens, dids: tokens.map((t) => jwt.decode(t).did) };
}
const adm = (m, url, body) => api(m, url, adminToken(admin), body);

test('admin can list devices; block takes effect on the very next request; unblock restores', async () => {
  const { u, tokens, dids } = await loggedIn('blk');
  const list = await adm('GET', `/api/admin/users/${u.id}/devices`);
  assert.equal(list.body.devices.length, 2);
  assert.equal(list.body.limit, 4);
  assert.ok(list.body.devices.every((d) => d.lastActiveAt && d.firstSeenAt));
  assert.ok(!JSON.stringify(list.body).includes('hash'));

  assert.equal((await api('GET', '/api/subscriptions/me', tokens[0])).status, 200);
  assert.equal((await adm('POST', `/api/admin/users/${u.id}/devices/${dids[0]}/block`)).status, 200);
  const denied = await api('GET', '/api/subscriptions/me', tokens[0]);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'device_blocked');
  assert.equal((await api('GET', '/api/subscriptions/me', tokens[1])).status, 200); // other device unaffected

  // a blocked device cannot get back in by logging in again, nor by reinstalling
  const relog = await login(u.email, phone('blk0', { installId: 'fresh-install' }));
  assert.equal(relog.status, 403);
  assert.equal(relog.body.code, 'device_blocked');

  assert.equal((await adm('POST', `/api/admin/users/${u.id}/devices/${dids[0]}/unblock`)).status, 200);
  assert.equal((await api('GET', '/api/subscriptions/me', tokens[0])).status, 200);
});

test('removing a device frees the slot and signs that device out; it can re-register while a slot is free', async () => {
  const { u, tokens, dids } = await loggedIn('rm', 2);
  assert.equal((await login(u.email, phone('rm-extra'))).status, 403); // full
  assert.equal((await adm('DELETE', `/api/admin/users/${u.id}/devices/${dids[1]}`)).status, 200);
  const gone = await api('GET', '/api/subscriptions/me', tokens[1]);
  assert.equal(gone.status, 403);
  assert.equal(gone.body.code, 'device_not_registered');
  assert.equal((await login(u.email, phone('rm-extra'))).status, 200); // slot reused
  assert.equal((await adm('DELETE', `/api/admin/users/${u.id}/devices/${dids[1]}`)).status, 404);
});

test('legacy / reset sessions re-register through POST /api/devices/register', async () => {
  const { u, tokens } = await loggedIn('rereg', 2);
  const reset = await adm('POST', `/api/admin/users/${u.id}/devices/reset`, {});
  assert.equal(reset.status, 200);
  assert.equal(reset.body.removed, 2);
  assert.equal((await api('GET', '/api/subscriptions/me', tokens[0])).body.code, 'device_not_registered');
  const re = await api('POST', '/api/devices/register', tokens[0], { device: phone('rereg0') });
  assert.equal(re.status, 200, JSON.stringify(re.body));
  assert.equal((await api('GET', '/api/subscriptions/me', re.body.token)).status, 200);
});

test('reset keeps blocked devices blocked unless includeBlocked is set', async () => {
  const { u, dids } = await loggedIn('rst', 4);
  await adm('POST', `/api/admin/users/${u.id}/devices/${dids[0]}/block`);
  const r1 = await adm('POST', `/api/admin/users/${u.id}/devices/reset`, {});
  assert.equal(r1.body.removed, 1);
  assert.equal((await login(u.email, phone('rst0'))).body.code, 'device_blocked');
  const r2 = await adm('POST', `/api/admin/users/${u.id}/devices/reset`, { includeBlocked: true });
  assert.equal(r2.body.removed, 1);
  assert.equal((await login(u.email, phone('rst0'))).status, 200);
});

test('lowering the limit below the registered count disables the NEWEST devices, not the oldest', async () => {
  const { u, tokens } = await loggedIn('low', 4);
  await adm('PATCH', `/api/admin/users/${u.id}/device-limit`, { limit: 1 });
  assert.equal((await api('GET', '/api/subscriptions/me', tokens[0])).status, 200);
  const over = await api('GET', '/api/subscriptions/me', tokens[1]);
  assert.equal(over.status, 403);
  assert.equal(over.body.code, 'device_over_limit');
  const list = await adm('GET', `/api/admin/users/${u.id}/devices`);
  assert.equal(list.body.overLimit, true);
});

test('unblock is refused if it would exceed the limit', async () => {
  const { u, dids } = await loggedIn('unb', 2);
  await adm('POST', `/api/admin/users/${u.id}/devices/${dids[0]}/block`);
  assert.equal((await login(u.email, phone('unbNew'))).status, 200); // takes the freed slot
  const r = await adm('POST', `/api/admin/users/${u.id}/devices/${dids[0]}/unblock`);
  assert.equal(r.status, 409);
});

test('device endpoints are admin-only', async () => {
  const { u, tokens, dids } = await loggedIn('auth');
  assert.equal((await api('GET', `/api/admin/users/${u.id}/devices`, tokens[0])).status, 403);
  assert.equal((await api('PATCH', `/api/admin/users/${u.id}/device-limit`, tokens[0], { limit: 4 })).status, 403);
  assert.equal((await api('DELETE', `/api/admin/users/${u.id}/devices/${dids[0]}`, tokens[0])).status, 403);
  assert.equal((await api('GET', `/api/admin/users/${u.id}/devices`)).status, 401);
});

// ================================================================== trials

const claim = (token) => api('POST', '/api/subscriptions/me/trial', token);
async function listener(email, limit) {
  const u = await mkUser(email, { limit });
  const r = await login(u.email, phone(`tr${uniq()}`));
  assert.equal(r.status, 200);
  return { u, token: r.body.token };
}

test('trial: eligible -> claim -> 72h term, entitled, history recorded', async () => {
  const { u, token } = await listener(`trial-${uniq()}@it.test`);
  const before = await api('GET', '/api/subscriptions/me', token);
  assert.equal(before.body.trial.eligible, true);
  assert.equal(before.body.access.entitled, false);

  const t0 = Date.now();
  const r = await claim(token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = r.body.subscription;
  assert.equal(s.status, 'trial');
  assert.equal(s.plan, 'trial');
  assert.equal(s.isTrial, true);
  assert.equal(s.entitled, true);
  assert.equal(s.daysRemaining, 3);
  const ms = Date.parse(s.expiresAt) - t0;
  assert.ok(ms > 72 * 3600e3 - 5000 && ms < 72 * 3600e3 + 5000, `expires in ${ms}ms`);

  const me = await api('GET', '/api/subscriptions/me', token);
  assert.equal(me.body.trial.used, true);
  assert.equal(me.body.trial.eligible, false);
  const hist = await adm('GET', `/api/subscriptions/${u.id}`);
  assert.deepEqual(hist.body.history.map((h) => h.action), ['trial_claimed']);
  assert.equal(hist.body.trial.used, true);
});

test('trial: cannot be claimed twice (while active, after revoke, after expiry, after logout/reinstall/new device)', async () => {
  const email = `once-${uniq()}@it.test`;
  const { u, token } = await listener(email, 4);
  assert.equal((await claim(token)).status, 200);
  assert.equal((await claim(token)).status, 409); // still running

  // admin revokes -> eligibility is NOT restored
  assert.equal((await adm('DELETE', `/api/subscriptions/${u.id}/trial`)).status, 200);
  const again = await claim(token);
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'trial_already_used');

  // logout/login, reinstall (new install id), brand-new phone -- same email, same answer
  const re = await login(email, phone(`newphone${uniq()}`));
  assert.equal(re.status, 200);
  assert.equal((await claim(re.body.token)).body.code, 'trial_already_used');

  // natural expiry
  await supabase.from('trial_claims').delete().eq('email_normalized', email); // simulate "a fresh eligible user" ...
  assert.equal((await claim(re.body.token)).status, 200);
  await supabase.from('subscriptions').update({ expires_at: new Date(Date.now() - 3600e3).toISOString() }).eq('user_id', u.id);
  const expired = await api('GET', '/api/subscriptions/me', re.body.token);
  assert.equal(expired.body.subscription.status, 'expired');
  assert.equal(expired.body.access.entitled, false);
  assert.equal(expired.body.access.reason, 'trial_expired');
  const afterExpiry = await claim(re.body.token);
  assert.equal(afterExpiry.status, 409); // has a (lapsed) subscription row and a ledger row
});

test('trial: concurrent claims from one email -> exactly one wins', async () => {
  const { token } = await listener(`trace-${uniq()}@it.test`);
  const rs = await Promise.all(Array.from({ length: 10 }, () => claim(token)));
  assert.equal(rs.filter((r) => r.status === 200).length, 1);
  assert.equal(rs.filter((r) => r.status === 409).length, 9);
});

test('trial: email aliases (Gmail dots, +tags, googlemail) cannot claim a second trial', async () => {
  const stem = `al${uniq().replace(/[^a-z0-9]/g, '')}`;
  const a = await listener(`${stem}@gmail.com`);
  assert.equal((await claim(a.token)).status, 200);
  for (const alias of [`${stem.slice(0, 2)}.${stem.slice(2)}@gmail.com`, `${stem}+promo@gmail.com`, `${stem}@googlemail.com`, `${stem.toUpperCase()}@GMAIL.COM`]) {
    const b = await listener(alias);
    const r = await claim(b.token);
    assert.equal(r.status, 409, alias);
    assert.equal(r.body.code, 'trial_already_used', alias);
  }
  const other = await listener(`different${uniq().replace(/[^a-z0-9]/g, '')}@gmail.com`);
  assert.equal((await claim(other.token)).status, 200); // a genuinely different inbox is fine
});

test('trial history is permanent: deleting the account and re-registering the email does not reset it', async () => {
  const email = `perm-${uniq()}@it.test`;
  const { u, token } = await listener(email);
  assert.equal((await claim(token)).status, 200);
  await supabase.from('app_users').delete().eq('id', u.id); // cascades subscription + devices
  const { data: kept } = await supabase.from('trial_claims').select('*').eq('email_normalized', email).single();
  assert.equal(kept.user_id, null); // survived, detached
  const again = await listener(email);
  assert.equal((await claim(again.token)).body.code, 'trial_already_used');
});

test('TRIAL_BLOCK_REUSED_DEVICE=on stops one phone farming trials across emails (off by default)', async () => {
  const shared = phone('farm');
  const mk = async () => {
    const u = await mkUser(`farm-${uniq()}@it.test`);
    const r = await login(u.email, shared);
    assert.equal(r.status, 200);
    return r.body.token;
  };
  const t1 = await mk();
  const t2 = await mk();
  assert.equal((await claim(t1)).status, 200);
  assert.equal((await claim(t2)).status, 200); // default: per-email only
  process.env.TRIAL_BLOCK_REUSED_DEVICE = 'on';
  try {
    const t3 = await mk();
    const r = await claim(t3);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'trial_device_used');
  } finally { delete process.env.TRIAL_BLOCK_REUSED_DEVICE; }
});

test('a user who already has a paid subscription cannot claim a trial', async () => {
  const { u, token } = await listener(`paid-${uniq()}@it.test`);
  await adm('POST', `/api/subscriptions/${u.id}/assign`, { plan: 30 });
  const r = await claim(token);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'has_subscription');
});

test('admin grant / revoke trial; override needs force; never overwrites a live paid plan', async () => {
  const { u, token } = await listener(`adm-${uniq()}@it.test`);
  const g = await adm('POST', `/api/subscriptions/${u.id}/trial`, {});
  assert.equal(g.status, 200);
  assert.equal(g.body.subscription.status, 'trial');
  assert.equal((await adm('POST', `/api/subscriptions/${u.id}/trial`, {})).body.code, 'trial_active');

  assert.equal((await adm('DELETE', `/api/subscriptions/${u.id}/trial`)).status, 200);
  assert.equal((await api('GET', '/api/subscriptions/me', token)).body.subscription.status, 'none');
  assert.equal((await adm('DELETE', `/api/subscriptions/${u.id}/trial`)).status, 404);

  const refused = await adm('POST', `/api/subscriptions/${u.id}/trial`, {});
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'trial_already_used');
  assert.equal(refused.body.canForce, true);
  const forced = await adm('POST', `/api/subscriptions/${u.id}/trial`, { force: true });
  assert.equal(forced.status, 200);
  const { data: ledger } = await supabase.from('trial_claims').select('times_granted').eq('email_normalized', u.email).single();
  assert.equal(ledger.times_granted, 2);

  // plan "trial" through the generic assign endpoint is the same operation
  const u2 = (await listener(`adm2-${uniq()}@it.test`)).u;
  assert.equal((await adm('POST', `/api/subscriptions/${u2.id}/assign`, { plan: 'trial' })).body.subscription.status, 'trial');

  // a live paid plan is never replaced by a trial
  await adm('POST', `/api/subscriptions/${u.id}/assign`, { plan: 90 });
  const over = await adm('POST', `/api/subscriptions/${u.id}/trial`, { force: true });
  assert.equal(over.status, 409);
  assert.equal(over.body.code, 'has_subscription');
});

test('a listener cannot call admin trial endpoints or claim for someone else', async () => {
  const { u, token } = await listener(`nope-${uniq()}@it.test`);
  assert.equal((await api('POST', `/api/subscriptions/${u.id}/trial`, token, { force: true })).status, 403);
  assert.equal((await api('DELETE', `/api/subscriptions/${u.id}/trial`, token)).status, 403);
});

test('a trial cannot be extended, and a plan change cannot switch to trial', async () => {
  const { u } = await listener(`ext-${uniq()}@it.test`);
  await adm('POST', `/api/subscriptions/${u.id}/trial`, {});
  assert.equal((await adm('POST', `/api/subscriptions/${u.id}/extend`, { days: 5 })).status, 400);
  await adm('POST', `/api/subscriptions/${u.id}/assign`, { plan: 30 });
  assert.equal((await adm('PATCH', `/api/subscriptions/${u.id}`, { plan: 'trial' })).status, 400);
});

// ========================================= plans: upgrade / downgrade labels

test('upgrade / downgrade / renew are recorded distinctly; trial -> paid keeps full history', async () => {
  const { u } = await listener(`plan-${uniq()}@it.test`);
  await adm('POST', `/api/subscriptions/${u.id}/trial`, {});
  await adm('POST', `/api/subscriptions/${u.id}/assign`, { plan: 30 }); // trial -> 30
  await adm('PATCH', `/api/subscriptions/${u.id}`, { plan: 365 });       // upgrade
  await adm('PATCH', `/api/subscriptions/${u.id}`, { plan: 90 });        // downgrade
  await adm('PATCH', `/api/subscriptions/${u.id}`, { endDate: S.addDays(S.todayString(), 200) }); // custom
  const d = await adm('GET', `/api/subscriptions/${u.id}`);
  assert.deepEqual(d.body.history.map((h) => h.action).reverse(),
    ['trial_granted', 'renewed', 'upgraded', 'downgraded', 'modified']);
  assert.equal(d.body.subscription.plan, 'custom');
  const { data: row } = await supabase.from('subscriptions').select('plan, is_trial, expires_at').eq('user_id', u.id).single();
  assert.equal(row.is_trial, false);
  assert.equal(row.expires_at, null);
});

test('all six plans can be assigned by an admin with correct end dates', async () => {
  const { u } = await listener(`six-${uniq()}@it.test`);
  const today = S.todayString();
  for (const [plan, days] of [[30, 30], [90, 90], [180, 180], [365, 365]]) {
    const r = await adm('POST', `/api/subscriptions/${u.id}/assign`, { plan });
    assert.equal(r.body.subscription.endDate, S.addDays(today, days));
    assert.equal(r.body.subscription.plan, String(plan));
  }
  const life = await adm('POST', `/api/subscriptions/${u.id}/assign`, { plan: 'lifetime' });
  assert.equal(life.body.subscription.status, 'lifetime');
  assert.equal(life.body.subscription.entitled, true);
  assert.equal((await adm('POST', `/api/subscriptions/${u.id}/assign`, { plan: 'trial', force: true })).status, 409); // won't clobber lifetime
});

// ========================================================== enforcement

let mediaId;
test.before(async () => {
  const { data, error } = await supabase.from('media_items').insert({
    type: 'music', title: 'T', storage_file_id: 'f1', storage_hash: 'h1', storage_path: 't.mp3',
  }).select().single();
  assert.ifError(error);
  mediaId = data.id;
});

test('server enforcement: stream-url / download-url need a valid subscription or running trial', async () => {
  const { u, token } = await listener(`enf-${uniq()}@it.test`);
  for (const route of ['stream-url', 'download-url']) {
    const r = await api('GET', `/api/storage/${route}/${mediaId}`, token);
    assert.equal(r.status, 403, route);
    assert.equal(r.body.code, 'subscription_required');
    assert.equal(r.body.reason, 'none');
  }
  await claim(token);
  const ok = await api('GET', `/api/storage/stream-url/${mediaId}`, token);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.match(ok.body.url, /token=/);

  // The direct Bearer path of the proxy is gated too (no way around stream-url).
  await supabase.from('subscriptions').update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('user_id', u.id);
  ent.clearEntitlementCache();
  const direct = await api('GET', `/api/storage/stream/${mediaId}`, token);
  assert.equal(direct.status, 403);
  assert.equal(direct.body.reason, 'trial_expired');
  assert.equal((await api('GET', `/api/storage/stream-url/${mediaId}`, token)).body.reason, 'trial_expired');

  // admin assigns a paid plan -> immediately works again
  await adm('POST', `/api/subscriptions/${u.id}/assign`, { plan: 30 });
  assert.equal((await api('GET', `/api/storage/stream-url/${mediaId}`, token)).status, 200);
});

test('expired paid plan, not-started plan, and revoked plan are all refused; lifetime and admin pass', async () => {
  const { u, token } = await listener(`paid2-${uniq()}@it.test`);
  const stream = () => api('GET', `/api/storage/stream-url/${mediaId}`, token);
  const today = S.todayString();
  await adm('POST', `/api/subscriptions/${u.id}/assign`, { plan: 30, startDate: S.addDays(today, -60) });
  assert.equal((await stream()).body.reason, 'expired');
  await adm('POST', `/api/subscriptions/${u.id}/assign`, { plan: 30, startDate: S.addDays(today, 5) });
  assert.equal((await stream()).body.reason, 'upcoming');
  await adm('POST', `/api/subscriptions/${u.id}/assign`, { plan: 'lifetime' });
  assert.equal((await stream()).status, 200);
  await adm('DELETE', `/api/subscriptions/${u.id}`);
  assert.equal((await stream()).body.reason, 'none');
  assert.equal((await api('GET', `/api/storage/stream-url/${mediaId}`, adminToken(admin))).status, 200);
});

test('SUBSCRIPTION_ENFORCEMENT=off lifts the gate (staged rollout) without touching device checks', async () => {
  const { token } = await listener(`off-${uniq()}@it.test`);
  process.env.SUBSCRIPTION_ENFORCEMENT = 'off';
  try {
    assert.equal((await api('GET', `/api/storage/stream-url/${mediaId}`, token)).status, 200);
  } finally { delete process.env.SUBSCRIPTION_ENFORCEMENT; }
  assert.equal((await api('GET', `/api/storage/stream-url/${mediaId}`, token)).status, 403);
});

test('DEVICE_ENFORCEMENT=off lets old app builds log in without device info', async () => {
  process.env.DEVICE_ENFORCEMENT = 'off';
  try {
    const u = await mkUser(`oldapp-${uniq()}@it.test`);
    const r = await login(u.email);
    assert.equal(r.status, 200);
    assert.equal(jwt.decode(r.body.token).did, undefined);
    assert.equal((await api('GET', '/api/subscriptions/me', r.body.token)).status, 200);
  } finally { delete process.env.DEVICE_ENFORCEMENT; }
});

test('a token with no device binding is refused on listener routes (old session after rollout)', async () => {
  const u = await mkUser(`unbound-${uniq()}@it.test`);
  const legacy = jwt.sign({ sub: u.id, email: u.email, role: 'listener' }, process.env.JWT_SECRET);
  const r = await api('GET', '/api/subscriptions/me', legacy);
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'device_not_registered');
  // ...but it can bootstrap a registration
  const reg = await api('POST', '/api/devices/register', legacy, { device: phone(`legacy${uniq()}`) });
  assert.equal(reg.status, 200);
  assert.equal((await api('GET', '/api/subscriptions/me', reg.body.token)).status, 200);
});

test('heartbeat refreshes last-active; /devices/me reports the verdict', async () => {
  const { u, token } = await listener(`hb-${uniq()}@it.test`);
  await supabase.from('user_devices').update({ last_active_at: '2020-01-01T00:00:00Z' }).eq('user_id', u.id);
  assert.equal((await api('POST', '/api/devices/heartbeat', token)).status, 200);
  const { data } = await supabase.from('user_devices').select('last_active_at').eq('user_id', u.id).single();
  assert.ok(Date.parse(data.last_active_at) > Date.parse('2024-01-01'));
  const me = await api('GET', '/api/devices/me', token);
  assert.equal(me.body.allowed, true);
  assert.equal(me.body.limit, 1);
});

// ===================================================== admin dashboard list

test('dashboard list: trial / active / expired / lifetime filters agree with derived status; search by email', async () => {
  const tag = uniq().replace(/[^a-z0-9]/g, '');
  const today = S.todayString();
  const mk = async (name) => (await mkUser(`${name}${tag}@dash.test`)).id;
  const ids = {
    trialLive: await mk('trlive'), trialDead: await mk('trdead'), active: await mk('act'), gone: await mk('gone'),
    life: await mk('life'), none: await mk('none'),
  };
  await adm('POST', `/api/subscriptions/${ids.trialLive}/trial`, {});
  await adm('POST', `/api/subscriptions/${ids.trialDead}/trial`, {});
  await supabase.from('subscriptions').update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('user_id', ids.trialDead);
  await adm('POST', `/api/subscriptions/${ids.active}/assign`, { plan: 90 });
  await adm('POST', `/api/subscriptions/${ids.gone}/assign`, { plan: 30, startDate: S.addDays(today, -90) });
  await adm('POST', `/api/subscriptions/${ids.life}/assign`, { plan: 'lifetime' });

  const emails = async (status) =>
    (await adm('GET', `/api/subscriptions?status=${status}&limit=100&q=${tag}`)).body.users.map((x) => x.email.split(tag)[0]).sort();
  assert.deepEqual(await emails('trial'), ['trlive']);
  assert.deepEqual(await emails('expired'), ['gone', 'trdead']); // an expired TRIAL counts as expired
  assert.deepEqual(await emails('active'), ['act']);              // trials are not "active paid"
  assert.deepEqual(await emails('lifetime'), ['life']);
  assert.deepEqual(await emails('none'), ['none']);

  const all = await adm('GET', `/api/subscriptions?limit=100&q=${tag}`);
  const byEmail = Object.fromEntries(all.body.users.map((x) => [x.email.split(tag)[0], x]));
  assert.equal(byEmail.trlive.subscription.status, 'trial');
  assert.equal(byEmail.trdead.subscription.status, 'expired');
  assert.equal(byEmail.trdead.subscription.plan, 'trial');
  assert.equal(byEmail.act.deviceLimit, 1);
  assert.equal(byEmail.act.deviceCount, 0);

  const whole = await adm('GET', '/api/subscriptions?limit=1');
  for (const k of ['all', 'active', 'trial', 'expiring', 'expired', 'lifetime', 'upcoming', 'none']) assert.equal(typeof whole.body.summary[k], 'number', k);
  assert.ok(whole.body.summary.trial >= 1);
});

// ========================================================= activity log

test('every admin action is in the activity log with who / what / whom', async () => {
  const { u } = await listener(`log-${uniq()}@it.test`, 2);
  await adm('POST', `/api/subscriptions/${u.id}/assign`, { plan: 90 });
  await adm('POST', `/api/subscriptions/${u.id}/extend`, { days: 10 });
  await adm('PATCH', `/api/subscriptions/${u.id}`, { plan: 365 });
  await adm('PATCH', `/api/admin/users/${u.id}/device-limit`, { limit: 3 });
  const dev = (await adm('GET', `/api/admin/users/${u.id}/devices`)).body.devices[0];
  await adm('POST', `/api/admin/users/${u.id}/devices/${dev.id}/block`);
  await adm('POST', `/api/admin/users/${u.id}/devices/${dev.id}/unblock`);
  await adm('DELETE', `/api/admin/users/${u.id}/devices/${dev.id}`);
  await adm('POST', `/api/admin/users/${u.id}/devices/reset`, {});
  await adm('DELETE', `/api/subscriptions/${u.id}`);

  const r = await adm('GET', `/api/admin/activity?userId=${u.id}&limit=50`);
  assert.equal(r.status, 200);
  const actions = r.body.entries.map((e) => e.action).reverse();
  assert.deepEqual(actions, [
    'subscription.assigned', 'subscription.extended', 'subscription.upgraded',
    'device.limit', 'device.block', 'device.unblock', 'device.remove', 'device.reset', 'subscription.revoke',
  ]);
  const e = r.body.entries.find((x) => x.action === 'device.limit');
  assert.equal(e.adminEmail, admin.email);
  assert.equal(e.targetEmail, u.email);
  assert.deepEqual([e.details.from, e.details.to], [2, 3]);
  assert.equal((await api('GET', '/api/admin/activity', adminToken(admin) + 'x')).status, 401);
  assert.equal(((await api('GET', '/api/admin/activity?q=' + encodeURIComponent('%,()'), adminToken(admin))).status), 200);
});

test('records survive logout / reinstall / data clearing: subscription, trial ledger and devices live only in the database', async () => {
  const email = `persist-${uniq()}@it.test`;
  const { u, token } = await listener(email);
  await adm('POST', `/api/subscriptions/${u.id}/assign`, { plan: 180 });
  const p = phone('persist');
  await supabase.from('user_devices').delete().eq('user_id', u.id);
  const a = await login(email, p);
  const b = await login(email, { ...p, installId: 'totally-new-install' });
  assert.equal(jwt.decode(a.body.token).did, jwt.decode(b.body.token).did);
  const me = await api('GET', '/api/subscriptions/me', b.body.token);
  assert.equal(me.body.subscription.plan, '180');
  assert.equal(me.body.subscription.entitled, true);
  void token;
});
