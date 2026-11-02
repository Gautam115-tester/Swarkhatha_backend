/**
 * Server-side access control for listeners. The backend is the single source
 * of truth: the app can show whatever it likes, but audio only flows if these
 * two gates say yes.
 *
 *   deviceGate          mounted in front of every listener-facing router.
 *                       A valid listener token must belong to a registered,
 *                       un-blocked device that is within the user's limit.
 *   requireEntitlement  on stream-url / download-url (and on the direct
 *                       Bearer path of stream / file). The subscription (or
 *                       running trial) must be valid right now.
 *
 * Admins are never gated. Both gates can be switched off for a staged
 * rollout (DEVICE_ENFORCEMENT=off / SUBSCRIPTION_ENFORCEMENT=off).
 */
'use strict';

const jwt = require('jsonwebtoken');
const supabase = require('../lib/supabaseClient');
const sub = require('../lib/subscription');
const devices = require('../lib/devices');

const ENT_TTL_MS = Number(process.env.ENTITLEMENT_CACHE_TTL_MS ?? 10000);
const entCache = new Map(); // userId -> { at, row }

function subscriptionEnforced() {
  return String(process.env.SUBSCRIPTION_ENFORCEMENT || 'on').toLowerCase() !== 'off';
}

function invalidateEntitlement(userId) {
  if (userId) entCache.delete(userId);
}
function clearEntitlementCache() {
  entCache.clear();
}

async function loadSubscriptionRow(userId) {
  const hit = entCache.get(userId);
  if (hit && Date.now() - hit.at < ENT_TTL_MS) return hit.row;
  const { data, error } = await supabase.from('subscriptions').select('*').eq('user_id', userId).maybeSingle();
  if (error) throw new Error(`entitlement lookup failed: ${error.message}`);
  entCache.set(userId, { at: Date.now(), row: data });
  if (entCache.size > 5000) entCache.delete(entCache.keys().next().value);
  return data;
}

const REASON_TEXT = {
  none: 'You need a subscription to listen. Start your free trial or contact the SwarKatha team.',
  upcoming: 'Your subscription has not started yet.',
  expired: 'Your subscription has expired. Contact the SwarKatha team to renew.',
  trial_expired: 'Your free trial has ended. Contact the SwarKatha team to get a subscription.',
};

/** Current access verdict for a user (never cached beyond ENT_TTL_MS). */
async function accessFor(userId, now = new Date()) {
  const row = await loadSubscriptionRow(userId);
  return { row, ...sub.entitlement(row, sub.todayString(now), now) };
}

async function deviceGate(req, res, next) {
  try {
    if (!devices.deviceEnforced()) return next();
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return next(); // the route's own auth answers 401
    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (_) {
      return next(); // invalid/expired token: let requireAuth return its 401
    }
    if (payload.role !== 'listener') return next();

    const verdict = payload.did ? await devices.checkDevice(payload.sub, payload.did) : 'missing';
    if (verdict === 'ok') {
      req.deviceId = payload.did;
      return next();
    }
    const r = devices.VERDICT_RESPONSES[verdict] || devices.VERDICT_RESPONSES.missing;
    return res.status(r.status).json({ error: r.error, code: r.code });
  } catch (e) {
    next(e);
  }
}

async function requireEntitlement(req, res, next) {
  try {
    if (!subscriptionEnforced()) return next();
    if (req.viaMediaToken) return next(); // token was minted behind this very check
    if (!req.user || req.user.role === 'admin') return next();
    const access = await accessFor(req.user.sub);
    if (access.entitled) return next();
    return res.status(403).json({
      error: REASON_TEXT[access.reason] || REASON_TEXT.none,
      code: 'subscription_required',
      reason: access.reason,
    });
  } catch (e) {
    next(e);
  }
}

module.exports = {
  subscriptionEnforced,
  deviceGate,
  requireEntitlement,
  accessFor,
  invalidateEntitlement,
  clearEntitlementCache,
  REASON_TEXT,
};
