/**
 * Manual subscription logic -- the single source of truth for how a
 * subscription's end date, status and remaining days are worked out.
 *
 * Everything here is PURE (no database, no network), which is what makes it
 * easy to test and what keeps the admin app and the listener app in
 * agreement: the database only stores start_date / end_date / is_lifetime,
 * and every status or "days left" number is derived from those on read.
 * Nothing is stored that could go stale, so there is no job whose failure
 * could leave a user showing "Active" after their subscription ended.
 *
 * DATE MODEL
 *   Dates are plain calendar days as 'YYYY-MM-DD' strings -- never
 *   timestamps -- so there are no time-of-day or DST edge cases.
 *   end_date = start_date + duration. A 30-day plan starting 1 Jan ends on
 *   31 Jan; it is still valid through the end of 31 Jan and shows Expired
 *   from 1 Feb. "Remaining days" = end_date - today, so it reads 30 on the
 *   start day and 0 ("expires today") on the end date.
 *
 *   "Today" is the calendar day in SUBSCRIPTION_TZ (default Asia/Kolkata,
 *   where the listeners are) rather than the server's UTC day -- otherwise
 *   every status would flip at 5:30 AM IST instead of midnight.
 */
'use strict';

const PLAN_DAYS = [30, 90, 180, 365];
const LIFETIME = 'lifetime';
const TRIAL = 'trial';

// The six plans. Order = rank, used to label a plan change as an upgrade or a
// downgrade. 'custom' (an admin-typed end date) has no rank.
const PLAN_ORDER = [TRIAL, '30', '90', '180', '365', LIFETIME];
const TRIAL_DAYS = 3;
// Trials end at an exact instant (claim time + 72 h), unlike paid plans which
// run through the end of a calendar day -- "3 days" must mean 3 days.
const TRIAL_HOURS = TRIAL_DAYS * 24;

// Status turns "expiring_soon" this many days (or fewer) before the end date.
const EXPIRING_SOON_DAYS = 7;
// Reminders sent this many days before expiry.
const NOTICE_THRESHOLDS = [7, 3, 1];
// If the job was down when a subscription lapsed, still send the "expired"
// notice for this many days afterwards -- but not for long-dead subscriptions
// (e.g. one an admin back-dated into the past).
const EXPIRED_NOTICE_WINDOW_DAYS = 3;

// Sanity bounds for admin-entered dates (the calendar allows any custom date).
const MIN_DATE = '2000-01-01';
const MAX_DATE = '2200-12-31';

const DEFAULT_TZ = 'Asia/Kolkata';

const MS_PER_DAY = 86400000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ----------------------------------------------------------------- dates

/** 'YYYY-MM-DD' -> UTC midnight in ms, or null if it isn't a real calendar date. */
function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  // Date.UTC silently rolls 2026-02-31 over to March; reject that.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return ms;
}

function isValidDate(s) {
  return parseDate(s) !== null;
}

function formatDate(ms) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** Adds (or, if negative, subtracts) whole days to a 'YYYY-MM-DD' date. */
function addDays(dateStr, days) {
  const ms = parseDate(dateStr);
  if (ms === null) throw new Error(`Invalid date: ${dateStr}`);
  return formatDate(ms + days * MS_PER_DAY);
}

/** Whole days from b to a (a - b). Negative when a is before b. */
function diffDays(a, b) {
  const am = parseDate(a);
  const bm = parseDate(b);
  if (am === null || bm === null) throw new Error(`Invalid date: ${am === null ? a : b}`);
  return Math.round((am - bm) / MS_PER_DAY);
}

/** Today's calendar date in [tz] as 'YYYY-MM-DD'. */
function todayString(now = new Date(), tz = process.env.SUBSCRIPTION_TZ || DEFAULT_TZ) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
  } catch (_) {
    // Bad SUBSCRIPTION_TZ value: fall back rather than 500 every request.
    return todayString(now, DEFAULT_TZ);
  }
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** '2026-11-05' -> '5 Nov 2026' (used in notification text). */
function humanDate(dateStr) {
  const ms = parseDate(dateStr);
  if (ms === null) return String(dateStr);
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function dateInBounds(s) {
  return isValidDate(s) && s >= MIN_DATE && s <= MAX_DATE;
}

// ----------------------------------------------------------------- plans

/**
 * Accepts 30 / '30' / 90 / ... / 'lifetime' and returns
 * { lifetime: true } | { lifetime: false, days } -- or null if it isn't one of
 * the offered plans. Custom lengths are NOT plans (use Extend or Modify for
 * those), so the admin UI and the API offer exactly the same five options.
 */
function parsePlan(input) {
  if (typeof input === 'string' && input.trim().toLowerCase() === LIFETIME) return { lifetime: true };
  if (typeof input === 'string' && input.trim().toLowerCase() === TRIAL) return { trial: true };
  const n = typeof input === 'number' ? input : /^\d+$/.test(String(input ?? '').trim()) ? Number(input) : NaN;
  if (PLAN_DAYS.includes(n)) return { lifetime: false, days: n };
  return null;
}

/** End date for a plan starting on [startDate]; null for lifetime. */
function computeEndDate(startDate, plan) {
  return plan.lifetime ? null : addDays(startDate, plan.days);
}

/** Stored plan key for a parsed plan: 'trial' | '30' | ... | 'lifetime'. */
function planKey(plan) {
  if (plan.trial) return TRIAL;
  return plan.lifetime ? LIFETIME : String(plan.days);
}

/** Rank of a stored plan key (higher = bigger plan); null for 'custom'/unknown. */
function planRank(key) {
  const i = PLAN_ORDER.indexOf(String(key));
  return i === -1 ? null : i;
}

/** 'upgraded' | 'downgraded' | null (same plan, or either side is custom). */
function planChangeAction(fromKey, toKey) {
  const a = planRank(fromKey);
  const b = planRank(toKey);
  if (a === null || b === null || a === b) return null;
  return b > a ? 'upgraded' : 'downgraded';
}

const PLAN_LABELS = {
  trial: '3-Day Free Trial',
  30: '30 Days',
  90: '90 Days',
  180: '180 Days',
  365: '365 Days',
  lifetime: 'Lifetime',
  custom: 'Custom',
};
function planLabel(key) {
  return PLAN_LABELS[key] || String(key);
}

// ---------------------------------------------------------------- emails

/**
 * Canonical form of an email for the one-trial-per-email ledger.
 *   - trimmed + lower-cased
 *   - "+tag" removed from the local part (a+1@x.com is a@x.com)
 *   - Gmail / Googlemail: dots removed too and googlemail.com -> gmail.com
 * Without this, a@gmail.com, a.b@gmail.com and a+2@gmail.com (all one inbox)
 * could each claim a trial. Returns null for something that isn't an email.
 */
function normalizeEmail(input) {
  if (typeof input !== 'string') return null;
  const raw = input.trim().toLowerCase();
  const at = raw.lastIndexOf('@');
  if (at < 1 || at === raw.length - 1) return null;
  let local = raw.slice(0, at);
  let domain = raw.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus >= 0) local = local.slice(0, plus);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  if (!local || !domain) return null;
  return `${local}@${domain}`;
}

// ------------------------------------------------------------ time zones

/** Offset (ms) of [tz] from UTC at the instant [utcMs]: local wall clock - UTC. */
function tzOffsetMs(utcMs, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * The UTC instant (ms) at which calendar day [dateStr] begins in [tz]
 * (00:00 local). Used to tell the app exactly when a paid term stops being
 * valid, without the app having to know the business time zone.
 */
function zonedMidnightUtcMs(dateStr, tz = process.env.SUBSCRIPTION_TZ || DEFAULT_TZ) {
  const ms = parseDate(dateStr);
  if (ms === null) throw new Error(`Invalid date: ${dateStr}`);
  let zone = tz;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); } catch (_) { zone = DEFAULT_TZ; }
  let guess = ms - tzOffsetMs(ms, zone);
  guess = ms - tzOffsetMs(guess, zone); // second pass settles DST edges
  return guess;
}

// ---------------------------------------------------------------- status

/**
 * Derives everything a screen needs from a stored row (or null) and today's
 * date. [row] needs { start_date, end_date, is_lifetime }.
 *
 *   status: 'none' | 'upcoming' | 'active' | 'expiring_soon' | 'expired' | 'lifetime'
 *
 * 'none' (no subscription yet) and 'upcoming' (admin picked a start date in
 * the future) are not among the four statuses the product spec names, but a
 * user with no row and a not-yet-started term both exist, and calling either
 * of them "Active" or "Expired" would be wrong.
 */
function deriveState(row, today, now = new Date()) {
  if (!row) {
    return { status: 'none', totalDays: null, daysRemaining: null, startsInDays: null, expiredDaysAgo: null, hoursRemaining: null };
  }

  // A trial is judged by its exact expires_at instant, not by calendar days.
  if (row.is_trial) {
    const exp = Date.parse(row.expires_at);
    const leftMs = Number.isFinite(exp) ? exp - now.getTime() : -1;
    if (leftMs <= 0) {
      return {
        status: 'expired',
        totalDays: TRIAL_DAYS,
        daysRemaining: 0,
        startsInDays: 0,
        expiredDaysAgo: Math.max(0, Math.floor(-leftMs / MS_PER_DAY)),
        hoursRemaining: 0,
      };
    }
    return {
      status: 'trial',
      totalDays: TRIAL_DAYS,
      daysRemaining: Math.ceil(leftMs / MS_PER_DAY),
      startsInDays: 0,
      expiredDaysAgo: null,
      hoursRemaining: Math.ceil(leftMs / 3600000),
    };
  }

  const startsInDays = diffDays(row.start_date, today);
  const upcoming = startsInDays > 0;

  if (row.is_lifetime) {
    return {
      status: upcoming ? 'upcoming' : 'lifetime',
      totalDays: null,
      daysRemaining: null, // Lifetime never counts down.
      startsInDays: upcoming ? startsInDays : 0,
      expiredDaysAgo: null,
    };
  }

  const totalDays = diffDays(row.end_date, row.start_date);
  if (upcoming) {
    return { status: 'upcoming', totalDays, daysRemaining: totalDays, startsInDays, expiredDaysAgo: null };
  }

  const left = diffDays(row.end_date, today);
  if (left < 0) {
    return { status: 'expired', totalDays, daysRemaining: 0, startsInDays: 0, expiredDaysAgo: -left };
  }
  return {
    status: left <= EXPIRING_SOON_DAYS ? 'expiring_soon' : 'active',
    totalDays,
    daysRemaining: left,
    startsInDays: 0,
    expiredDaysAgo: null,
  };
}

/**
 * Does this row grant access to premium content RIGHT NOW?
 * This is the one function the server (and nothing else) uses to decide.
 *
 *   { entitled, reason, validUntil }
 *   reason: 'active' | 'trial' | 'lifetime'                       (entitled)
 *           'none' | 'upcoming' | 'expired' | 'trial_expired'     (not entitled)
 *   validUntil: ISO instant access ends (null for lifetime / no access) --
 *   sent to the app so offline playback can be bounded without the app
 *   re-implementing the date rules.
 */
function entitlement(row, today, now = new Date(), tz) {
  if (!row) return { entitled: false, reason: 'none', validUntil: null };
  if (row.is_trial) {
    const exp = Date.parse(row.expires_at);
    const ok = Number.isFinite(exp) && now.getTime() < exp;
    return { entitled: ok, reason: ok ? 'trial' : 'trial_expired', validUntil: Number.isFinite(exp) ? new Date(exp).toISOString() : null };
  }
  if (diffDays(row.start_date, today) > 0) return { entitled: false, reason: 'upcoming', validUntil: null };
  if (row.is_lifetime) return { entitled: true, reason: 'lifetime', validUntil: null };
  const left = diffDays(row.end_date, today);
  return {
    entitled: left >= 0,
    reason: left >= 0 ? 'active' : 'expired',
    validUntil: new Date(zonedMidnightUtcMs(addDays(row.end_date, 1), tz)).toISOString(),
  };
}

/** The camelCase object both Flutter apps consume. */
function toPublic(row, today, now = new Date()) {
  const state = deriveState(row, today, now);
  const ent = entitlement(row, today, now);
  return {
    status: state.status,
    plan: row?.plan ?? (row ? (row.is_lifetime ? LIFETIME : 'custom') : null),
    isLifetime: !!row?.is_lifetime,
    isTrial: !!row?.is_trial,
    startDate: row?.start_date ?? null,
    endDate: row?.end_date ?? null,
    expiresAt: row?.is_trial ? row.expires_at ?? null : null,
    totalDays: state.totalDays,
    daysRemaining: state.daysRemaining,
    hoursRemaining: state.hoursRemaining ?? null,
    startsInDays: state.startsInDays,
    expiredDaysAgo: state.expiredDaysAgo,
    entitled: ent.entitled,
    entitlementReason: ent.reason,
    validUntil: ent.validUntil,
    note: row?.note ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

// --------------------------------------------------------- admin actions

/**
 * New term from a plan + start date (used for Assign and Renew).
 * Returns the column values to store.
 */
function termFromPlan(plan, startDate) {
  return {
    is_lifetime: !!plan.lifetime,
    start_date: startDate,
    end_date: computeEndDate(startDate, plan),
    plan: planKey(plan),
    is_trial: false,
    expires_at: null,
  };
}

/**
 * Extend by [days]. Returns the new column values, or { error }.
 *  - Lifetime can't be extended (nothing to add to).
 *  - Active / expiring / upcoming: the days are added to the current end
 *    date, so none of the time already paid for is lost.
 *  - Already expired: counting on from the old end date would still leave it
 *    expired (or give back less than [days]), so a fresh term starts today.
 */
function extendTerm(row, days, today) {
  if (row.is_trial) return { error: 'A free trial cannot be extended. Assign a paid plan instead.' };
  if (row.is_lifetime) return { error: 'A lifetime subscription never expires, so there is nothing to extend.' };
  if (diffDays(row.end_date, today) < 0) {
    return { is_lifetime: false, start_date: today, end_date: addDays(today, days) };
  }
  return { is_lifetime: false, start_date: row.start_date, end_date: addDays(row.end_date, days) };
}

// --------------------------------------------------------- notifications

/**
 * Which reminder (if any) is due for a subscription today?
 * Returns { kind, daysLeft, endDate } or null.
 *
 * Only the MOST urgent applicable reminder is returned. If the job was down
 * for a few days and only runs at 2 days left, the user gets the "3 days"
 * reminder (worded with the real number), not the 7-day and 3-day ones in a
 * burst. Combined with the unique dedupe key per (user, kind, end date), each
 * reminder is sent at most once per term however often this runs.
 */
function dueNotice(row, today, now = new Date()) {
  if (!row || row.is_lifetime) return null;
  if (row.is_trial) {
    // A 3-day trial gets no countdown reminders (they'd all fire on day one);
    // just a single "your trial has ended" note once it lapses.
    const exp = Date.parse(row.expires_at);
    if (!Number.isFinite(exp) || exp > now.getTime()) return null;
    if ((now.getTime() - exp) / MS_PER_DAY > EXPIRED_NOTICE_WINDOW_DAYS) return null;
    return { kind: 'trial_expired', daysLeft: 0, endDate: todayString(new Date(exp)) };
  }
  if (diffDays(row.start_date, today) > 0) return null; // hasn't started yet
  const daysLeft = diffDays(row.end_date, today);
  if (daysLeft < 0) {
    return -daysLeft <= EXPIRED_NOTICE_WINDOW_DAYS ? { kind: 'expired', daysLeft: 0, endDate: row.end_date } : null;
  }
  const threshold = [...NOTICE_THRESHOLDS].sort((a, b) => a - b).find((t) => daysLeft <= t);
  if (threshold === undefined) return null;
  return { kind: `expiry_${threshold}`, daysLeft, endDate: row.end_date };
}

function dedupeKey(userId, kind, endDate) {
  return `${userId}:${kind}:${endDate}`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Title + body for an expiry reminder / expired notice. */
function buildNotice({ kind, daysLeft, endDate }) {
  const ends = humanDate(endDate);
  if (kind === 'trial_expired') {
    return {
      title: 'Your free trial has ended',
      body: `Your ${TRIAL_DAYS}-day SwarKatha free trial ended on ${ends}. Contact the SwarKatha team to get a subscription.`,
    };
  }
  if (kind === 'expired') {
    return {
      title: 'Your subscription has expired',
      body: `Your SwarKatha subscription ended on ${ends}. Contact the SwarKatha team to renew it.`,
    };
  }
  if (daysLeft <= 0) {
    return {
      title: 'Your subscription expires today',
      body: `Your SwarKatha subscription ends today (${ends}). 0 days remaining.`,
    };
  }
  if (daysLeft === 1) {
    return {
      title: 'Your subscription expires tomorrow',
      body: `Your SwarKatha subscription ends tomorrow (${ends}). 1 day remaining.`,
    };
  }
  return {
    title: `Your subscription expires in ${daysLeft} days`,
    body: `Your SwarKatha subscription ends on ${ends}. ${plural(daysLeft, 'day')} remaining.`,
  };
}

/** The "an admin changed your subscription" inbox note. */
function buildUpdateNotice(action, pub) {
  if (action === 'removed') {
    return { title: 'Subscription removed', body: 'Your SwarKatha subscription has been removed by an admin.' };
  }
  if (action === 'trial_revoked') {
    return { title: 'Free trial ended', body: 'Your SwarKatha free trial was ended by an admin.' };
  }
  if (action === 'trial_granted' || action === 'trial_claimed') {
    return {
      title: 'Free trial started',
      body: `Your ${TRIAL_DAYS}-day SwarKatha free trial is active until ${humanDate(todayString(new Date(pub.expiresAt)))}.`,
    };
  }
  const verb = {
    assigned: 'activated',
    renewed: 'renewed',
    extended: 'extended',
    modified: 'updated',
    upgraded: 'upgraded',
    downgraded: 'changed',
  }[action] || 'updated';
  if (pub.isLifetime) {
    return { title: `Subscription ${verb}`, body: 'You now have Lifetime Access to SwarKatha.' };
  }
  const tail =
    pub.status === 'upcoming'
      ? `It starts on ${humanDate(pub.startDate)} and ends on ${humanDate(pub.endDate)}.`
      : `It now ends on ${humanDate(pub.endDate)} (${plural(pub.daysRemaining, 'day')} remaining).`;
  return { title: `Subscription ${verb}`, body: `Your SwarKatha subscription was ${verb}. ${tail}` };
}

module.exports = {
  PLAN_DAYS,
  PLAN_ORDER,
  LIFETIME,
  TRIAL,
  TRIAL_DAYS,
  TRIAL_HOURS,
  EXPIRING_SOON_DAYS,
  NOTICE_THRESHOLDS,
  EXPIRED_NOTICE_WINDOW_DAYS,
  MIN_DATE,
  MAX_DATE,
  parseDate,
  isValidDate,
  dateInBounds,
  addDays,
  diffDays,
  todayString,
  humanDate,
  parsePlan,
  computeEndDate,
  planKey,
  planRank,
  planChangeAction,
  planLabel,
  normalizeEmail,
  zonedMidnightUtcMs,
  entitlement,
  deriveState,
  toPublic,
  termFromPlan,
  extendTerm,
  dueNotice,
  dedupeKey,
  buildNotice,
  buildUpdateNotice,
};
