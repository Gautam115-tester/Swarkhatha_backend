/**
 * Manual subscription management. NO payments, billing or auto-renewal
 * anywhere in here -- an admin sets everything by hand from the admin app.
 *
 *   Listener (any logged-in user)
 *     GET  /api/subscriptions/me                     own subscription + unread count
 *     GET  /api/subscriptions/me/notifications       own inbox (expiry reminders etc.)
 *     POST /api/subscriptions/me/notifications/read  mark some / all as read
 *
 *   Admin only
 *     GET    /api/subscriptions?status=&q=&limit=&offset=   listener list + summary
 *     GET    /api/subscriptions/:userId                     one listener + history
 *     POST   /api/subscriptions/:userId/assign              new term: plan + start date
 *     POST   /api/subscriptions/:userId/renew               (same as assign; replaces the term)
 *     POST   /api/subscriptions/:userId/extend              add N days to the end date
 *     PATCH  /api/subscriptions/:userId                     edit start / end / plan / note
 *     DELETE /api/subscriptions/:userId                     remove the subscription
 *
 *   Scheduler (secret header, not a user token)
 *     POST /api/subscriptions/cron/run                      run the expiry-reminder sweep
 *
 * Status and remaining days are never stored -- every response derives them
 * from start/end date and today's date (lib/subscription.js), so the admin
 * app and the listener app always agree and nothing needs a job to stay
 * correct.
 */
const crypto = require('crypto');
const express = require('express');
const supabase = require('../lib/supabaseClient');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const sub = require('../lib/subscription');
const notifier = require('../lib/subscriptionNotifier');
const devices = require('../lib/devices');
const { logAdmin } = require('../lib/adminLog');
const { invalidateEntitlement } = require('../middleware/entitlement');
const { trialLimiter } = require('../middleware/rateLimit');

const router = express.Router();
const admin = [requireAuth, requireAdmin];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_EXTEND_DAYS = 3650;
const MAX_NOTE_LENGTH = 500;
const LIST_FILTERS = ['all', 'active', 'trial', 'expiring', 'expired', 'lifetime', 'upcoming', 'none'];

// Express 4 doesn't catch rejected promises from async handlers; forward
// them to the JSON error handler in server.js instead of hanging the request.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const fail = (res, status, error, code) => res.status(status).json(code ? { error, code } : { error });

// ============================================================= listener

router.get('/me', requireAuth, wrap(async (req, res) => {
  const now = new Date();
  const today = sub.todayString(now);
  const { data: row, error } = await supabase
    .from('subscriptions').select('*').eq('user_id', req.user.sub).maybeSingle();
  if (error) return fail(res, 500, error.message);

  // Generate this listener's due reminder right now (idempotent), so they are
  // told the moment they open the app even if no scheduler ran.
  if (row) await notifier.ensureForUser(row, req.user.sub, today);

  const { count } = await supabase
    .from('user_notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', req.user.sub)
    .is('read_at', null);

  const pub = sub.toPublic(row, today, now);
  const trial = await trialStatusFor(req.user.sub, req.user.email, row);
  let deviceInfo = null;
  if (req.user.role !== 'admin') {
    const { data: lim } = await supabase.from('app_users').select('device_limit').eq('id', req.user.sub).maybeSingle();
    const { count: active } = await supabase
      .from('user_devices').select('id', { count: 'exact', head: true }).eq('user_id', req.user.sub).eq('status', 'active');
    deviceInfo = { limit: lim?.device_limit ?? 1, activeCount: active ?? 0 };
  }
  res.json({
    today,
    serverTime: now.toISOString(),
    subscription: pub,
    access: {
      entitled: req.user.role === 'admin' ? true : pub.entitled,
      reason: pub.entitlementReason,
      validUntil: pub.validUntil,
      // How long the app may keep playing DOWNLOADED files without hearing
      // from the server again (it can't ask while offline).
      offlineGraceHours: Number(process.env.OFFLINE_GRACE_HOURS) || 72,
    },
    trial,
    devices: deviceInfo,
    unreadCount: count ?? 0,
  });
}));

/** Has this email had a trial, and could it claim one right now? */
async function trialStatusFor(userId, email, row) {
  const norm = sub.normalizeEmail(email);
  let used = false;
  let usedAt = null;
  if (norm) {
    const { data } = await supabase
      .from('trial_claims').select('first_claimed_at').eq('email_normalized', norm).maybeSingle();
    if (data) { used = true; usedAt = data.first_claimed_at; }
  }
  return { used, usedAt, eligible: !used && !row, lengthDays: sub.TRIAL_DAYS };
}

// ---- self-service: claim the one-time free trial ------------------------
router.post('/me/trial', trialLimiter, requireAuth, wrap(async (req, res) => {
  if (req.user.role === 'admin') return fail(res, 400, 'Admin accounts do not use free trials.');
  const { data: user, error } = await supabase
    .from('app_users').select('id, email, role, status').eq('id', req.user.sub).maybeSingle();
  if (error) return fail(res, 500, error.message);
  if (!user || user.status !== 'approved') return fail(res, 403, 'Account is not active.');

  const result = await grantTrial({
    user, source: 'self', adminId: null, force: false,
    deviceKeys: await devices.deviceKeys(user.id, req.user.did),
  });
  if (!result.ok) return fail(res, result.status, result.error, result.code);

  const now = new Date();
  const today = sub.todayString(now);
  await notifier.notifyChange(user.id, 'trial_claimed', result.row, today);
  const pub = sub.toPublic(result.row, today, now);
  res.json({ today, serverTime: now.toISOString(), subscription: pub, access: { entitled: pub.entitled, reason: pub.entitlementReason, validUntil: pub.validUntil } });
}));

const TRIAL_FAILURES = {
  has_subscription: [409, 'You already have a subscription, so a free trial is not available.'],
  trial_active: [409, 'A free trial is already running for this listener.'],
  trial_already_used: [409, 'This email has already used its free trial. Free trials can be claimed only once.'],
  trial_device_used: [409, 'A free trial has already been used on this device.'],
};

/**
 * Atomic trial claim/grant via sk_grant_trial(): eligibility ledger + term +
 * history in one transaction. Returns { ok, row } or { ok:false, status, error, code }.
 */
async function grantTrial({ user, source, adminId, force, deviceKeys = [] }) {
  const norm = sub.normalizeEmail(user.email);
  if (!norm) return { ok: false, status: 400, error: 'This account has no valid email address.', code: 'invalid_email' };
  const now = new Date();
  const { data, error } = await supabase.rpc('sk_grant_trial', {
    p_user_id: user.id,
    p_email: user.email,
    p_email_norm: norm,
    p_source: source,
    p_admin: adminId,
    p_force: !!force,
    p_device_keys: deviceKeys,
    p_check_device: String(process.env.TRIAL_BLOCK_REUSED_DEVICE || 'off').toLowerCase() === 'on',
    p_today: sub.todayString(now),
    p_end_date: sub.todayString(new Date(now.getTime() + sub.TRIAL_HOURS * 3600000)),
    p_hours: sub.TRIAL_HOURS,
  });
  if (error) throw new Error(`trial grant failed: ${error.message}`);
  invalidateEntitlement(user.id);
  if (!data.ok) {
    const [status, text] = TRIAL_FAILURES[data.code] || [409, 'Free trial is not available.'];
    return { ok: false, status, error: text, code: data.code };
  }
  return { ok: true, row: data.subscription };
}

router.get('/me/notifications', requireAuth, wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  const { data, error } = await supabase
    .from('user_notifications')
    .select('id, kind, title, body, created_at, read_at')
    .eq('user_id', req.user.sub)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return fail(res, 500, error.message);

  const { count } = await supabase
    .from('user_notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', req.user.sub)
    .is('read_at', null);

  res.json({
    unreadCount: count ?? 0,
    notifications: (data || []).map((n) => ({
      id: n.id,
      kind: n.kind,
      title: n.title,
      body: n.body,
      createdAt: n.created_at,
      readAt: n.read_at,
    })),
  });
}));

router.post('/me/notifications/read', requireAuth, wrap(async (req, res) => {
  const { ids, all } = req.body || {};
  let q = supabase
    .from('user_notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('user_id', req.user.sub)
    .is('read_at', null);
  if (all === true) {
    // everything unread for this user
  } else if (Array.isArray(ids) && ids.length > 0 && ids.length <= 200 && ids.every((i) => UUID_RE.test(String(i)))) {
    q = q.in('id', ids);
  } else {
    return fail(res, 400, 'Send { "all": true } or { "ids": [<notification ids>] }');
  }
  const { error } = await q;
  if (error) return fail(res, 500, error.message);
  res.json({ ok: true });
}));

// ============================================================= scheduler

// Same pattern as POST /api/storage/accounts/background-check: unset secret =
// route doesn't exist; otherwise the header must match (constant-time).
router.post('/cron/run', wrap(async (req, res) => {
  const secret = process.env.SUBSCRIPTION_CRON_SECRET;
  if (!secret) return fail(res, 404, 'Not found');
  const given = Buffer.from(String(req.get('x-cron-secret') || ''));
  const want = Buffer.from(secret);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return fail(res, 401, 'Unauthorized');
  }
  const result = await notifier.runExpiryCheck();
  res.json({ ok: true, ...result });
}));

// ================================================================= admin

/**
 * Narrows a user_subscription_overview query to one status bucket.
 * Trials are judged by their exact expires_at instant, paid terms by calendar
 * day, and these filters must agree with deriveState():
 *   expired  = end_date < today  OR  expires_at <= now
 *              (a trial's end_date is the day it ends, so a trial that expired
 *               at 3 pm today matches through its expires_at)
 */
function applyStatusFilter(q, status, today, nowIso = new Date().toISOString()) {
  const soon = sub.addDays(today, sub.EXPIRING_SOON_DAYS);
  switch (status) {
    case 'none':
      return q.is('subscription_id', null);
    case 'lifetime':
      return q.eq('is_lifetime', true).lte('start_date', today);
    case 'trial':
      return q.eq('is_trial', true).gt('expires_at', nowIso);
    case 'upcoming':
      return q.not('subscription_id', 'is', null).gt('start_date', today);
    case 'expired':
      return q.eq('is_lifetime', false).or(`end_date.lt.${today},expires_at.lte.${nowIso}`);
    case 'expiring':
      return q.eq('is_lifetime', false).eq('is_trial', false).gte('end_date', today).lte('end_date', soon).lte('start_date', today);
    case 'active':
      return q.eq('is_lifetime', false).eq('is_trial', false).gt('end_date', soon).lte('start_date', today);
    default:
      return q;
  }
}

/** Keeps only characters that can't alter a PostgREST filter expression. */
function sanitizeSearch(s) {
  return String(s || '').replace(/[^\p{L}\p{N} @._+-]/gu, '').trim().slice(0, 60);
}

function overviewRowToRow(r) {
  if (!r.subscription_id) return null;
  return {
    start_date: r.start_date, end_date: r.end_date, is_lifetime: r.is_lifetime, note: r.note,
    updated_at: r.subscription_updated_at, plan: r.plan, is_trial: !!r.is_trial, expires_at: r.expires_at,
  };
}

router.get('/', admin, wrap(async (req, res) => {
  const today = sub.todayString();
  const status = LIST_FILTERS.includes(req.query.status) ? req.query.status : 'all';
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const term = sanitizeSearch(req.query.q);

  let q = supabase
    .from('user_subscription_overview')
    .select('*', { count: 'exact' })
    .eq('account_status', 'approved');
  q = applyStatusFilter(q, status, today);
  if (term) q = q.or(`email.ilike.%${term}%,display_name.ilike.%${term}%`);

  if (status === 'expiring' || status === 'active') q = q.order('end_date', { ascending: true });
  else if (status === 'expired') q = q.order('end_date', { ascending: false });
  else q = q.order('joined_at', { ascending: false });
  q = q.order('user_id', { ascending: true }).range(offset, offset + limit - 1);

  // Whole-roster totals for the summary chips (independent of search/filter);
  // only needed on the first page.
  const summaryPromise = offset === 0 ? buildSummary(today) : Promise.resolve(null);
  const [{ data, error, count }, summary] = await Promise.all([q, summaryPromise]);
  if (error) return fail(res, 500, error.message);

  res.json({
    today,
    status,
    total: count ?? 0,
    summary,
    users: (data || []).map((r) => ({
      userId: r.user_id,
      email: r.email,
      displayName: r.display_name,
      joinedAt: r.joined_at,
      deviceLimit: r.device_limit ?? 1,
      deviceCount: r.device_count ?? 0,
      subscription: sub.toPublic(overviewRowToRow(r), today),
    })),
  });
}));

async function buildSummary(today) {
  const keys = ['all', 'active', 'trial', 'expiring', 'expired', 'lifetime', 'upcoming', 'none'];
  const results = await Promise.all(
    keys.map((k) =>
      applyStatusFilter(
        supabase
          .from('user_subscription_overview')
          .select('user_id', { count: 'exact', head: true })
          .eq('account_status', 'approved'),
        k,
        today
      )
    )
  );
  const out = {};
  keys.forEach((k, i) => { out[k] = results[i].count ?? 0; });
  return out;
}

async function loadListener(userId) {
  if (!UUID_RE.test(String(userId))) return { status: 400, error: 'Invalid user id' };
  const { data: user, error } = await supabase
    .from('app_users').select('id, email, display_name, role, status, created_at').eq('id', userId).maybeSingle();
  if (error) return { status: 500, error: error.message };
  if (!user || user.role !== 'listener') return { status: 404, error: 'Listener not found' };
  return { user };
}

async function currentRow(userId) {
  const { data, error } = await supabase.from('subscriptions').select('*').eq('user_id', userId).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

router.get('/:userId', admin, wrap(async (req, res) => {
  const found = await loadListener(req.params.userId);
  if (found.error) return fail(res, found.status, found.error);
  const today = sub.todayString();
  const row = await currentRow(found.user.id);

  const { data: history, error } = await supabase
    .from('subscription_history')
    .select('id, action, is_lifetime, start_date, end_date, detail, performed_by, created_at')
    .eq('user_id', found.user.id)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return fail(res, 500, error.message);

  const adminIds = [...new Set((history || []).map((h) => h.performed_by).filter(Boolean))];
  const names = new Map();
  if (adminIds.length) {
    const { data: admins } = await supabase.from('app_users').select('id, email, display_name').in('id', adminIds);
    for (const a of admins || []) names.set(a.id, a.display_name || a.email);
  }

  const trial = await trialStatusFor(found.user.id, found.user.email, row);
  const { data: claim } = await supabase
    .from('trial_claims').select('first_claimed_at, first_source, times_granted, last_granted_at')
    .eq('email_normalized', sub.normalizeEmail(found.user.email) || '').maybeSingle();
  const { count: deviceCount } = await supabase
    .from('user_devices').select('id', { count: 'exact', head: true }).eq('user_id', found.user.id).eq('status', 'active');
  const { data: limitRow } = await supabase.from('app_users').select('device_limit').eq('id', found.user.id).maybeSingle();

  res.json({
    today,
    user: { userId: found.user.id, email: found.user.email, displayName: found.user.display_name, joinedAt: found.user.created_at },
    subscription: sub.toPublic(row, today),
    trial: {
      ...trial,
      firstSource: claim?.first_source ?? null,
      timesGranted: claim?.times_granted ?? 0,
      lastGrantedAt: claim?.last_granted_at ?? null,
    },
    devices: { limit: limitRow?.device_limit ?? 1, activeCount: deviceCount ?? 0 },
    history: (history || []).map((h) => ({
      id: h.id,
      action: h.action,
      isLifetime: h.is_lifetime,
      startDate: h.start_date,
      endDate: h.end_date,
      detail: h.detail,
      performedBy: names.get(h.performed_by) || null,
      createdAt: h.created_at,
    })),
  });
}));

/** undefined = field not sent (leave as is); null/'' = clear; else trimmed text. */
function parseNote(v) {
  if (v === undefined) return { value: undefined };
  if (v === null || (typeof v === 'string' && v.trim() === '')) return { value: null };
  if (typeof v !== 'string' || v.length > MAX_NOTE_LENGTH) return { error: `note must be text up to ${MAX_NOTE_LENGTH} characters` };
  return { value: v.trim() };
}

/** Insert or update the single subscription row for a listener. */
async function writeTerm({ userId, existing, term, note, adminId }) {
  invalidateEntitlement(userId);
  const fields = { ...term, updated_by: adminId, updated_at: new Date().toISOString() };
  if (note !== undefined) fields.note = note;
  if (existing) {
    const { data, error } = await supabase.from('subscriptions').update(fields).eq('user_id', userId).select().single();
    if (error) throw new Error(error.message);
    return data;
  }
  const { data, error } = await supabase
    .from('subscriptions')
    .insert({ user_id: userId, created_by: adminId, note: note ?? null, ...fields })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

/** Audit-log entry + inbox note + the standard response. Logging never fails the action. */
async function finish(res, { userId, action, detail, row, adminId, today, notifyUser = true, req, target, extra }) {
  const { error } = await supabase.from('subscription_history').insert({
    user_id: userId,
    action,
    is_lifetime: !!row?.is_lifetime,
    start_date: row?.start_date ?? null,
    end_date: row?.end_date ?? null,
    detail,
    performed_by: adminId,
  });
  if (error) console.error('[subscriptions] history insert failed:', error.message);
  if (notifyUser) await notifier.notifyChange(userId, action, row, today);
  if (req) {
    await logAdmin(req, `subscription.${action}`, target || { id: userId }, { detail, plan: row?.plan ?? null, startDate: row?.start_date ?? null, endDate: row?.end_date ?? null, ...extra });
  }
  res.json({ today, subscription: sub.toPublic(row, today) });
}

// Assign (no subscription yet) and Renew (replace the current term) are the
// same operation underneath: pick a plan + start date, end date is computed.
const assignHandler = wrap(async (req, res) => {
  const found = await loadListener(req.params.userId);
  if (found.error) return fail(res, found.status, found.error);

  const body = req.body || {};
  const plan = sub.parsePlan(body.plan);
  if (!plan) return fail(res, 400, 'plan must be one of "trial", 30, 90, 180, 365 or "lifetime"');
  // The 3-day trial is one of the six plans an admin can hand out.
  if (plan.trial) return trialGrantHandler(req, res, found.user);

  const today = sub.todayString();
  const startDate = body.startDate === undefined ? today : body.startDate;
  if (!sub.dateInBounds(startDate)) return fail(res, 400, 'startDate must be a valid date as YYYY-MM-DD');
  const note = parseNote(body.note);
  if (note.error) return fail(res, 400, note.error);

  const existing = await currentRow(found.user.id);
  const row = await writeTerm({
    userId: found.user.id, existing, term: sub.termFromPlan(plan, startDate), note: note.value, adminId: req.user.sub,
  });
  await finish(res, {
    userId: found.user.id,
    action: existing ? 'renewed' : 'assigned',
    detail: plan.lifetime ? 'Lifetime plan' : `${plan.days}-day plan from ${startDate}`,
    row, adminId: req.user.sub, today,
    req, target: { id: found.user.id, email: found.user.email },
    extra: { previousPlan: existing?.plan ?? null },
  });
});
router.post('/:userId/assign', admin, assignHandler);
router.post('/:userId/renew', admin, assignHandler);

router.post('/:userId/extend', admin, wrap(async (req, res) => {
  const found = await loadListener(req.params.userId);
  if (found.error) return fail(res, found.status, found.error);

  const days = Number((req.body || {}).days);
  if (!Number.isInteger(days) || days < 1 || days > MAX_EXTEND_DAYS) {
    return fail(res, 400, `days must be a whole number from 1 to ${MAX_EXTEND_DAYS}`);
  }
  const existing = await currentRow(found.user.id);
  if (!existing) return fail(res, 404, 'This listener has no subscription to extend. Assign one first.');

  const today = sub.todayString();
  const term = sub.extendTerm(existing, days, today);
  if (term.error) return fail(res, 400, term.error);

  const row = await writeTerm({ userId: found.user.id, existing, term, adminId: req.user.sub });
  await finish(res, {
    userId: found.user.id, action: 'extended', detail: `+${days} days`, row, adminId: req.user.sub, today,
    req, target: { id: found.user.id, email: found.user.email }, extra: { days },
  });
}));

router.patch('/:userId', admin, wrap(async (req, res) => {
  const found = await loadListener(req.params.userId);
  if (found.error) return fail(res, found.status, found.error);

  const body = req.body || {};
  const existing = await currentRow(found.user.id);
  if (!existing) return fail(res, 404, 'This listener has no subscription to modify. Assign one first.');
  const today = sub.todayString();
  const note = parseNote(body.note);
  if (note.error) return fail(res, 400, note.error);

  for (const key of ['startDate', 'endDate']) {
    if (body[key] !== undefined && !sub.dateInBounds(body[key])) {
      return fail(res, 400, `${key} must be a valid date as YYYY-MM-DD`);
    }
  }

  let term;
  let detail;
  if (body.plan !== undefined) {
    // New plan -> end date is recomputed from the (possibly new) start date.
    const plan = sub.parsePlan(body.plan);
    if (!plan) return fail(res, 400, 'plan must be one of 30, 90, 180, 365 or "lifetime"');
    if (plan.trial) return fail(res, 400, 'Use "Grant free trial" to give a trial; a plan change cannot switch to a trial.');
    term = sub.termFromPlan(plan, body.startDate ?? existing.start_date);
    detail = plan.lifetime ? 'Changed to Lifetime' : `Changed to ${plan.days}-day plan from ${term.start_date}`;
  } else if (body.startDate !== undefined || body.endDate !== undefined) {
    const start = body.startDate ?? existing.start_date;
    if (body.endDate !== undefined) {
      if (body.endDate < start) return fail(res, 400, 'endDate cannot be before the start date');
      term = { is_lifetime: false, start_date: start, end_date: body.endDate, plan: 'custom', is_trial: false, expires_at: null };
      detail = `Dates set to ${start} - ${body.endDate}`;
    } else if (existing.is_lifetime) {
      term = { is_lifetime: true, start_date: start, end_date: null, plan: 'lifetime', is_trial: false, expires_at: null };
      detail = `Start date set to ${start}`;
    } else {
      if (existing.end_date < start) return fail(res, 400, 'The start date cannot be after the current end date');
      term = { is_lifetime: false, start_date: start, end_date: existing.end_date, plan: existing.is_trial ? 'custom' : existing.plan, is_trial: false, expires_at: null };
      detail = `Start date set to ${start}`;
    }
  } else if (note.value !== undefined) {
    term = { is_lifetime: existing.is_lifetime, start_date: existing.start_date, end_date: existing.end_date, plan: existing.plan, is_trial: existing.is_trial, expires_at: existing.expires_at };
    detail = 'Note updated';
  } else {
    return fail(res, 400, 'Nothing to change: send plan, startDate, endDate and/or note');
  }

  const datesChanged =
    term.is_lifetime !== existing.is_lifetime || term.start_date !== existing.start_date || term.end_date !== existing.end_date;
  // Switching to a bigger / smaller plan is an upgrade / downgrade; anything
  // else (dates, note) stays a plain modification.
  const action = (body.plan !== undefined && sub.planChangeAction(existing.plan, term.plan)) || 'modified';
  const row = await writeTerm({ userId: found.user.id, existing, term, note: note.value, adminId: req.user.sub });
  await finish(res, {
    userId: found.user.id, action, detail, row, adminId: req.user.sub, today,
    notifyUser: datesChanged, // a note-only edit is admin bookkeeping, not news for the listener
    req, target: { id: found.user.id, email: found.user.email }, extra: { previousPlan: existing.plan },
  });
}));

router.delete('/:userId', admin, wrap(async (req, res) => {
  const found = await loadListener(req.params.userId);
  if (found.error) return fail(res, found.status, found.error);
  const existing = await currentRow(found.user.id);
  if (!existing) return fail(res, 404, 'This listener has no subscription to remove.');
  await revokeRow(req, res, found.user, existing);
}));

/** Deletes the term (access ends immediately) and records it. Used for paid plans and trials. */
async function revokeRow(req, res, user, existing) {
  invalidateEntitlement(user.id);
  const { error } = await supabase.from('subscriptions').delete().eq('user_id', user.id);
  if (error) return fail(res, 500, error.message);
  invalidateEntitlement(user.id);

  const today = sub.todayString();
  const wasTrial = !!existing.is_trial;
  const { error: hErr } = await supabase.from('subscription_history').insert({
    user_id: user.id, action: wasTrial ? 'trial_revoked' : 'removed', is_lifetime: existing.is_lifetime,
    start_date: existing.start_date, end_date: existing.end_date,
    detail: wasTrial ? 'Free trial revoked' : 'Subscription revoked', performed_by: req.user.sub,
  });
  if (hErr) console.error('[subscriptions] history insert failed:', hErr.message);
  await notifier.notifyChange(user.id, wasTrial ? 'trial_revoked' : 'removed', null, today);
  await logAdmin(req, wasTrial ? 'trial.revoke' : 'subscription.revoke', { id: user.id, email: user.email }, { plan: existing.plan });
  res.json({ today, subscription: sub.toPublic(null, today) });
}

/** Shared by POST /:userId/trial and assign-with-plan-"trial". */
async function trialGrantHandler(req, res, user) {
  const result = await grantTrial({ user, source: 'admin', adminId: req.user.sub, force: (req.body || {}).force === true });
  if (!result.ok) {
    // Tell the admin an override exists, so the app can offer it.
    return res.status(result.status).json({
      error: result.error, code: result.code, canForce: result.code === 'trial_already_used',
    });
  }
  const now = new Date();
  const today = sub.todayString(now);
  await notifier.notifyChange(user.id, 'trial_granted', result.row, today);
  await logAdmin(req, 'trial.grant', { id: user.id, email: user.email }, { force: (req.body || {}).force === true });
  res.json({ today, subscription: sub.toPublic(result.row, today, now) });
}

router.post('/:userId/trial', admin, wrap(async (req, res) => {
  const found = await loadListener(req.params.userId);
  if (found.error) return fail(res, found.status, found.error);
  await trialGrantHandler(req, res, found.user);
}));

router.delete('/:userId/trial', admin, wrap(async (req, res) => {
  const found = await loadListener(req.params.userId);
  if (found.error) return fail(res, found.status, found.error);
  const existing = await currentRow(found.user.id);
  if (!existing || !existing.is_trial) return fail(res, 404, 'This listener has no free trial to revoke.');
  await revokeRow(req, res, found.user, existing);
}));

module.exports = router;
