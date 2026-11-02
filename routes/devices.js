/**
 * The listener's own device endpoints.
 *
 *   POST /api/devices/register   register THIS device and get a device-bound token.
 *                                Used when an existing session predates device
 *                                binding, or after an admin reset/removed the device.
 *   GET  /api/devices/me         is this device still allowed? + the user's limit.
 *   POST /api/devices/heartbeat  keeps "last active" fresh (called on app resume).
 *
 * Login itself also registers the device (routes/auth.js), so most users never
 * call /register at all.
 */
const express = require('express');
const supabase = require('../lib/supabaseClient');
const devices = require('../lib/devices');
const { requireAuth, signUserToken } = require('../middleware/auth');
const { deviceLimiter } = require('../middleware/rateLimit');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const listenerOnly = (req, res, next) =>
  req.user.role === 'admin' ? res.status(400).json({ error: 'Admins are not device-bound.' }) : next();

router.post('/register', deviceLimiter, requireAuth, listenerOnly, wrap(async (req, res) => {
  const parsed = devices.parseDevicePayload(req.body?.device);
  if (parsed.error) return res.status(400).json({ error: parsed.error, code: 'device_info_required' });

  const { data: user, error } = await supabase
    .from('app_users').select('id, email, role, status').eq('id', req.user.sub).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!user || user.status !== 'approved') return res.status(403).json({ error: 'Account is not active.' });

  const reg = await devices.registerDevice(user.id, parsed.device);
  const failure = devices.registrationFailure(reg);
  if (failure) return res.status(failure.status).json(failure.body);

  res.json({
    token: signUserToken(user, reg.device.id),
    device: reg.device,
    limit: reg.limit,
    activeCount: reg.activeCount,
  });
}));

router.get('/me', deviceLimiter, requireAuth, listenerOnly, wrap(async (req, res) => {
  const { data: u } = await supabase.from('app_users').select('device_limit').eq('id', req.user.sub).maybeSingle();
  const verdict = req.user.did ? await devices.checkDevice(req.user.sub, req.user.did) : 'missing';
  const { count } = await supabase
    .from('user_devices').select('id', { count: 'exact', head: true })
    .eq('user_id', req.user.sub).eq('status', 'active');
  res.json({
    deviceId: req.user.did ?? null,
    allowed: verdict === 'ok',
    verdict,
    limit: u?.device_limit ?? 1,
    activeCount: count ?? 0,
  });
}));

const lastTouch = new Map(); // deviceId -> ms
router.post('/heartbeat', deviceLimiter, requireAuth, listenerOnly, wrap(async (req, res) => {
  if (!req.user.did) return res.status(403).json({ code: 'device_not_registered', error: devices.VERDICT_RESPONSES.missing.error });
  const verdict = await devices.checkDevice(req.user.sub, req.user.did);
  if (verdict !== 'ok') {
    const r = devices.VERDICT_RESPONSES[verdict] || devices.VERDICT_RESPONSES.missing;
    return res.status(r.status).json({ code: r.code, error: r.error });
  }
  const now = Date.now();
  if (now - (lastTouch.get(req.user.did) || 0) > 5 * 60 * 1000) {
    lastTouch.set(req.user.did, now);
    if (lastTouch.size > 5000) lastTouch.delete(lastTouch.keys().next().value);
    const { error } = await supabase
      .from('user_devices').update({ last_active_at: new Date(now).toISOString() })
      .eq('id', req.user.did).eq('user_id', req.user.sub);
    if (error) console.error('[devices] heartbeat update failed:', error.message);
  }
  res.json({ ok: true });
}));

module.exports = router;
