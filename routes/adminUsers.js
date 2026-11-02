/**
 * Admin: device management + the activity log. Mounted at /api/admin.
 *
 *   GET    /users/:userId/devices                    registered devices + limit
 *   PATCH  /users/:userId/device-limit               { limit: 1 | 2 | 3 | 4 }
 *   DELETE /users/:userId/devices/:deviceId          remove one device (frees the slot)
 *   POST   /users/:userId/devices/:deviceId/block    block it (stays recorded; can't re-register)
 *   POST   /users/:userId/devices/:deviceId/unblock
 *   POST   /users/:userId/devices/reset              remove all devices ({ includeBlocked })
 *   GET    /activity?limit=&offset=&userId=&q=       the admin activity log
 *
 * Every change is written to admin_activity_log and takes effect on the
 * listener's very next request (the device-status cache is invalidated).
 */
const express = require('express');
const supabase = require('../lib/supabaseClient');
const devices = require('../lib/devices');
const { logAdmin } = require('../lib/adminLog');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
const admin = [requireAuth, requireAdmin];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (res, status, error) => res.status(status).json({ error });

async function loadListener(userId) {
  if (!UUID_RE.test(String(userId))) return { status: 400, error: 'Invalid user id' };
  const { data, error } = await supabase
    .from('app_users').select('id, email, display_name, role, device_limit').eq('id', userId).maybeSingle();
  if (error) return { status: 500, error: error.message };
  if (!data || data.role !== 'listener') return { status: 404, error: 'Listener not found' };
  return { user: data };
}

const DEVICE_COLS =
  'id, status, label, platform, manufacturer, model, os_version, app_version, secondary_env, clone_reasons, first_seen_at, last_active_at, login_count, blocked_at';

async function listDevices(userId) {
  const { data, error } = await supabase
    .from('user_devices').select(DEVICE_COLS).eq('user_id', userId)
    .order('first_seen_at', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

router.get('/users/:userId/devices', admin, wrap(async (req, res) => {
  const found = await loadListener(req.params.userId);
  if (found.error) return fail(res, found.status, found.error);
  const rows = await listDevices(found.user.id);
  const active = rows.filter((d) => d.status === 'active');
  res.json({
    user: { userId: found.user.id, email: found.user.email, displayName: found.user.display_name },
    limit: found.user.device_limit,
    activeCount: active.length,
    // Registered beyond the limit (an admin lowered it): the newest ones are not usable.
    overLimit: active.length > found.user.device_limit,
    devices: rows.map(devices.toPublicDevice),
  });
}));

router.patch('/users/:userId/device-limit', admin, wrap(async (req, res) => {
  const found = await loadListener(req.params.userId);
  if (found.error) return fail(res, found.status, found.error);
  const limit = (req.body || {}).limit;
  if (![1, 2, 3, 4].includes(limit)) return fail(res, 400, 'limit must be 1, 2, 3 or 4');

  const { error } = await supabase.from('app_users').update({ device_limit: limit }).eq('id', found.user.id);
  if (error) return fail(res, 500, error.message);
  devices.invalidateUser(found.user.id);
  await logAdmin(req, 'device.limit', found.user, { from: found.user.device_limit, to: limit });

  const rows = await listDevices(found.user.id);
  const active = rows.filter((d) => d.status === 'active').length;
  res.json({ limit, activeCount: active, overLimit: active > limit });
}));

async function loadDevice(res, userId, deviceId) {
  if (!UUID_RE.test(String(deviceId))) { fail(res, 400, 'Invalid device id'); return null; }
  const { data, error } = await supabase
    .from('user_devices').select(DEVICE_COLS).eq('id', deviceId).eq('user_id', userId).maybeSingle();
  if (error) { fail(res, 500, error.message); return null; }
  if (!data) { fail(res, 404, 'Device not found'); return null; }
  return data;
}

router.delete('/users/:userId/devices/:deviceId', admin, wrap(async (req, res) => {
  const found = await loadListener(req.params.userId);
  if (found.error) return fail(res, found.status, found.error);
  const dev = await loadDevice(res, found.user.id, req.params.deviceId);
  if (!dev) return;
  const { error } = await supabase.from('user_devices').delete().eq('id', dev.id).eq('user_id', found.user.id);
  if (error) return fail(res, 500, error.message);
  devices.invalidateUser(found.user.id);
  await logAdmin(req, 'device.remove', found.user, { deviceId: dev.id, label: dev.label, wasStatus: dev.status });
  res.json({ ok: true });
}));

for (const [verb, status] of [['block', 'blocked'], ['unblock', 'active']]) {
  router.post(`/users/:userId/devices/:deviceId/${verb}`, admin, wrap(async (req, res) => {
    const found = await loadListener(req.params.userId);
    if (found.error) return fail(res, found.status, found.error);
    const dev = await loadDevice(res, found.user.id, req.params.deviceId);
    if (!dev) return;

    if (status === 'active') {
      // Unblocking must not push the user past their limit.
      const rows = await listDevices(found.user.id);
      const active = rows.filter((d) => d.status === 'active').length;
      if (dev.status === 'blocked' && active >= found.user.device_limit) {
        return fail(res, 409, `Cannot unblock: the user already has ${active} of ${found.user.device_limit} devices. Remove one or raise the limit first.`);
      }
    }
    const { error } = await supabase.from('user_devices').update({
      status,
      blocked_at: status === 'blocked' ? new Date().toISOString() : null,
      blocked_by: status === 'blocked' ? req.user.sub : null,
      updated_at: new Date().toISOString(),
    }).eq('id', dev.id).eq('user_id', found.user.id);
    if (error) return fail(res, 500, error.message);
    devices.invalidateUser(found.user.id);
    await logAdmin(req, `device.${verb}`, found.user, { deviceId: dev.id, label: dev.label });
    res.json({ ok: true, status });
  }));
}

router.post('/users/:userId/devices/reset', admin, wrap(async (req, res) => {
  const found = await loadListener(req.params.userId);
  if (found.error) return fail(res, found.status, found.error);
  const includeBlocked = (req.body || {}).includeBlocked === true;

  const before = await listDevices(found.user.id);
  let q = supabase.from('user_devices').delete().eq('user_id', found.user.id);
  // By default a block survives a reset: wiping registrations must not
  // quietly un-block a device the admin deliberately blocked.
  if (!includeBlocked) q = q.eq('status', 'active');
  const { error } = await q;
  if (error) return fail(res, 500, error.message);
  devices.invalidateUser(found.user.id);

  const removed = before.filter((d) => includeBlocked || d.status === 'active').length;
  await logAdmin(req, 'device.reset', found.user, { removed, includeBlocked });
  res.json({ ok: true, removed });
}));

router.get('/activity', admin, wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  let q = supabase
    .from('admin_activity_log')
    .select('id, admin_email, action, target_user_id, target_email, details, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (req.query.userId) {
    if (!UUID_RE.test(String(req.query.userId))) return fail(res, 400, 'Invalid user id');
    q = q.eq('target_user_id', req.query.userId);
  }
  const term = String(req.query.q || '').replace(/[^\p{L}\p{N} @._+-]/gu, '').trim().slice(0, 60);
  if (term) q = q.or(`target_email.ilike.%${term}%,admin_email.ilike.%${term}%,action.ilike.%${term}%`);
  const { data, error, count } = await q;
  if (error) return fail(res, 500, error.message);
  res.json({
    total: count ?? 0,
    entries: (data || []).map((e) => ({
      id: e.id, adminEmail: e.admin_email, action: e.action, targetUserId: e.target_user_id,
      targetEmail: e.target_email, details: e.details || {}, createdAt: e.created_at,
    })),
  });
}));

module.exports = router;
