/**
 * Device registration + limits (server side).
 *
 * The phone reports several identity signals (see the Flutter side,
 * android/.../DeviceIdentity.kt). This module validates them, turns every raw
 * identifier into a KEYED HASH (HMAC with a server secret -- the database
 * never holds a raw Android ID or DRM id), and hands the result to the
 * sk_register_device() SQL function, which does the recognise-or-register
 * and limit check atomically.
 *
 * What "same physical device" means here is documented next to
 * sk_register_device in supabase/migration_trials_devices.sql.
 *
 * HONEST LIMITS: every signal is reported by the app, so a modified client
 * could invent fresh ids on each login. Nothing short of hardware attestation
 * (Play Integrity) closes that; this layer stops everything an ordinary user
 * can do: logout/login, reinstall, clear data, Dual Apps / second user /
 * work profile, and the common "app cloner" containers.
 */
'use strict';

const crypto = require('crypto');
const supabase = require('./supabaseClient');

const HEX = /^[0-9a-f]+$/i;
const REASON_RE = /^[a-z0-9_]{1,40}$/;
// Reasons the Android side reports for third-party sandboxes (as opposed to
// the OS's own Dual Apps / second user, which are legitimate).
const VIRTUAL_REASONS = new Set(['virtual_container', 'uid_mismatch', 'clone_package_path']);

function deviceEnforced() {
  return String(process.env.DEVICE_ENFORCEMENT || 'on').toLowerCase() !== 'off';
}

/** dedupe (default) | block_virtual | block_all -- see .env.example */
function clonePolicy() {
  const v = String(process.env.CLONE_POLICY || 'dedupe').toLowerCase();
  return ['dedupe', 'block_virtual', 'block_all'].includes(v) ? v : 'dedupe';
}

function secret() {
  const s = process.env.DEVICE_HASH_SECRET || process.env.TOKEN_ENC_KEY;
  if (!s) throw new Error('DEVICE_HASH_SECRET (or TOKEN_ENC_KEY) must be set to register devices');
  return s;
}

function h(kind, value) {
  return crypto.createHmac('sha256', secret()).update(`${kind}|${value}`).digest('hex');
}

function str(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

/**
 * Validates the device object the app sends. Returns { device } (cleaned) or
 * { error }. Everything is optional except that at least ONE identity signal
 * must be present -- a request with none can't be recognised later.
 */
function parseDevicePayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'device information is required' };

  const androidId = str(raw.androidId, 64);
  const hardwareId = str(raw.hardwareId, 128);
  const hardwareSignature = str(raw.hardwareSignature, 128);
  const installId = str(raw.installId, 64);
  if (androidId && androidId.length < 4) return { error: 'invalid androidId' };
  if (hardwareId && !HEX.test(hardwareId)) return { error: 'invalid hardwareId' };
  if (hardwareSignature && !HEX.test(hardwareSignature)) return { error: 'invalid hardwareSignature' };
  if (!androidId && !hardwareId && !hardwareSignature && !installId) {
    return { error: 'device information is required' };
  }

  const reasons = Array.isArray(raw.cloneReasons)
    ? [...new Set(raw.cloneReasons.filter((r) => typeof r === 'string' && REASON_RE.test(r)))].slice(0, 8)
    : [];
  const userHandle = Number.isInteger(raw.userHandle) && raw.userHandle >= 0 && raw.userHandle < 1e6 ? raw.userHandle : 0;

  return {
    device: {
      platform: str(raw.platform, 16)?.toLowerCase() === 'ios' ? 'ios' : 'android',
      androidId,
      hardwareId,
      hardwareSignature,
      installId,
      manufacturer: str(raw.manufacturer, 60),
      model: str(raw.model, 80),
      osVersion: str(raw.osVersion, 40),
      appVersion: str(raw.appVersion, 40),
      userHandle,
      cloneReasons: reasons,
      secondaryEnv: raw.secondaryEnv === true || userHandle > 0 || reasons.length > 0,
    },
  };
}

/** Parsed device -> the hashed jsonb the SQL function takes. */
function toRpcDevice(d) {
  const mfr = (d.manufacturer || '').toLowerCase();
  const model = (d.model || '').toLowerCase();
  return {
    android_id_hash: d.androidId ? h('aid', d.androidId) : null,
    // The DRM id alone is not unique on every low-end handset, so it is bound
    // to the make + model before hashing.
    drm_hash: d.hardwareId ? h('drm', `${d.hardwareId}|${mfr}|${model}`) : null,
    hw_signature: d.hardwareSignature ? h('hw', d.hardwareSignature) : null,
    install_id: d.installId,
    secondary_env: d.secondaryEnv,
    clone_reasons: d.cloneReasons,
    platform: d.platform,
    manufacturer: d.manufacturer,
    model: d.model,
    os_version: d.osVersion,
    app_version: d.appVersion,
    label: [d.manufacturer, d.model].filter(Boolean).join(' ') || null,
  };
}

/** Policy check that runs BEFORE touching the database. Returns an error message or null. */
function cloneViolation(d) {
  const policy = clonePolicy();
  if (policy === 'dedupe') return null;
  if (policy === 'block_all' && d.secondaryEnv) {
    return 'This app is running in a cloned / secondary environment, which is not allowed. Please use the original app.';
  }
  if (policy === 'block_virtual' && d.cloneReasons.some((r) => VIRTUAL_REASONS.has(r))) {
    return 'This app is running inside an app-cloning container, which is not allowed. Please use the original app.';
  }
  return null;
}

const toPublicDevice = (d) => ({
  id: d.id,
  status: d.status,
  label: d.label,
  platform: d.platform,
  manufacturer: d.manufacturer,
  model: d.model,
  osVersion: d.os_version,
  appVersion: d.app_version,
  isCloneEnvironment: !!d.secondary_env,
  cloneReasons: d.clone_reasons || [],
  firstSeenAt: d.first_seen_at,
  lastActiveAt: d.last_active_at,
  loginCount: d.login_count,
  blockedAt: d.blocked_at ?? null,
});

/**
 * Atomically recognise-or-register. Returns one of
 *   { result: 'registered'|'existing', device, limit, activeCount }
 *   { result: 'limit_reached', limit, activeCount, devices }
 *   { result: 'blocked', device }
 *   { result: 'clone_blocked', message }
 *   { result: 'no_user' }
 * Throws on a database error.
 */
async function registerDevice(userId, parsedDevice) {
  const violation = cloneViolation(parsedDevice);
  if (violation) return { result: 'clone_blocked', message: violation };

  const { data, error } = await supabase.rpc('sk_register_device', {
    p_user_id: userId,
    p_dev: toRpcDevice(parsedDevice),
  });
  if (error) throw new Error(`device registration failed: ${error.message}`);
  invalidateUser(userId);
  return {
    result: data.result,
    device: data.device ? toPublicDevice(data.device) : undefined,
    limit: data.limit,
    activeCount: data.active_count,
    devices: Array.isArray(data.devices) ? data.devices.map(toPublicDevice) : undefined,
  };
}

/**
 * Maps a non-success registration result to { status, body } for the HTTP
 * response, or null when the device is in (registered / existing).
 */
function registrationFailure(reg) {
  switch (reg.result) {
    case 'registered':
    case 'existing':
      return null;
    case 'limit_reached':
      return {
        status: 403,
        body: {
          code: 'device_limit_reached',
          error: `Device limit reached (${reg.activeCount} of ${reg.limit}). Ask the SwarKatha team to remove a device or raise your limit.`,
          limit: reg.limit,
          activeCount: reg.activeCount,
          devices: (reg.devices || []).map((d) => ({ label: d.label, lastActiveAt: d.lastActiveAt })),
        },
      };
    case 'blocked':
      return { status: 403, body: { code: 'device_blocked', error: VERDICT_RESPONSES.blocked.error } };
    case 'clone_blocked':
      return { status: 403, body: { code: 'clone_blocked', error: reg.message } };
    default:
      return { status: 404, body: { error: 'Account not found' } };
  }
}

// ------------------------------------------------------------ status cache
// Every listener request passes the device gate, so the verdict is cached for
// a few seconds. Admin actions (remove / block / limit change) invalidate it
// immediately on THIS instance; across instances the TTL bounds the delay.
const TTL_MS = Number(process.env.DEVICE_CHECK_TTL_MS ?? 15000);
const cache = new Map(); // deviceId -> { at, userId, verdict }

async function checkDevice(userId, deviceId) {
  const hit = cache.get(deviceId);
  if (hit && hit.userId === userId && Date.now() - hit.at < TTL_MS) return hit.verdict;
  const { data, error } = await supabase.rpc('sk_check_device', { p_user_id: userId, p_device_id: deviceId });
  if (error) throw new Error(`device check failed: ${error.message}`);
  cache.set(deviceId, { at: Date.now(), userId, verdict: data });
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return data;
}

function invalidateUser(userId) {
  for (const [k, v] of cache) if (v.userId === userId) cache.delete(k);
}
function clearCache() { cache.clear(); }

/** Hashed ids of a registered device (for the optional trial-per-device check). */
async function deviceKeys(userId, deviceId) {
  if (!deviceId) return [];
  const { data } = await supabase
    .from('user_devices')
    .select('android_id_hashes, drm_hashes')
    .eq('id', deviceId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!data) return [];
  return [...(data.drm_hashes || []), ...(data.android_id_hashes || [])];
}

const VERDICT_RESPONSES = {
  missing: {
    status: 403,
    code: 'device_not_registered',
    error: 'This device is not registered to your account. Please sign in again.',
  },
  blocked: {
    status: 403,
    code: 'device_blocked',
    error: 'This device has been blocked by an admin. Contact the SwarKatha team.',
  },
  over_limit: {
    status: 403,
    code: 'device_over_limit',
    error: 'Your device limit was reduced and this device is no longer included. Contact the SwarKatha team.',
  },
};

module.exports = {
  deviceEnforced,
  clonePolicy,
  parseDevicePayload,
  toRpcDevice,
  cloneViolation,
  toPublicDevice,
  registerDevice,
  registrationFailure,
  checkDevice,
  invalidateUser,
  clearCache,
  deviceKeys,
  VERDICT_RESPONSES,
};
