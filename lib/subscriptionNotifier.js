/**
 * Subscription expiry notifications.
 *
 * Reminders go to the listener's in-app inbox (user_notifications) and,
 * best-effort, to their email via lib/mailer.js. They are generated three
 * ways, all running the same idempotent code:
 *
 *   1. The listener's own GET /api/subscriptions/me (ensureForUser) --
 *      so a user is reminded the moment they open the app, even if the
 *      server was asleep (Render's free tier) and no timer ever fired.
 *   2. An in-process hourly timer (startScheduler) while the instance is
 *      awake.
 *   3. POST /api/subscriptions/cron/run, hit by an external scheduler so
 *      emails go out even if nobody opens the app (see DEPLOYMENT.md).
 *
 * Idempotency: every notification carries a unique dedupe_key of
 * "<user>:<kind>:<end_date>", inserted with ON CONFLICT DO NOTHING. However
 * many times and from however many places this runs, each reminder exists at
 * most once per term -- and extending/renewing changes end_date, so the new
 * term automatically gets its own fresh set. Only the run that actually
 * inserted the row sends the email, so nobody is mailed twice.
 */
'use strict';

const supabase = require('./supabaseClient');
const mailer = require('./mailer');
const sub = require('./subscription');

const PAGE = 500;

/**
 * Creates today's due reminder (if any) for one subscription row.
 * [user] needs { id, email }. Returns true if a NEW notification was created.
 * Never throws: notifications are a nice-to-have, never worth failing the
 * request that happened to trigger them.
 */
async function ensureForSubscription(row, user, today) {
  try {
    const due = sub.dueNotice(row, today, new Date());
    if (!due) return false;
    const { title, body } = sub.buildNotice(due);
    const { data, error } = await supabase
      .from('user_notifications')
      .upsert(
        {
          user_id: user.id,
          kind: due.kind,
          title,
          body,
          dedupe_key: sub.dedupeKey(user.id, due.kind, due.endDate),
        },
        { onConflict: 'dedupe_key', ignoreDuplicates: true }
      )
      .select('id');
    if (error) {
      console.error('[subscriptions] notification insert failed:', error.message);
      return false;
    }
    if (!data || data.length === 0) return false; // already sent for this term

    if (user.email) {
      mailer.sendSubscriptionEmail(user.email, title, `${body}\n\n— SwarKatha`).catch((e) =>
        console.error('[subscriptions] email failed:', e.message)
      );
    }
    return true;
  } catch (e) {
    console.error('[subscriptions] ensureForSubscription failed:', e.message);
    return false;
  }
}

/** Used by GET /me: looks up the listener's email only if a reminder is due. */
async function ensureForUser(row, userId, today) {
  if (!sub.dueNotice(row, today, new Date())) return false;
  const { data: user } = await supabase.from('app_users').select('id, email').eq('id', userId).maybeSingle();
  if (!user) return false;
  return ensureForSubscription(row, user, today);
}

/** The "an admin changed your subscription" inbox note (no email, no dedupe). */
async function notifyChange(userId, action, row, today) {
  try {
    const { title, body } = sub.buildUpdateNotice(action, sub.toPublic(row, today));
    const { error } = await supabase
      .from('user_notifications')
      .insert({ user_id: userId, kind: 'subscription_updated', title, body });
    if (error) console.error('[subscriptions] update notice failed:', error.message);
  } catch (e) {
    console.error('[subscriptions] notifyChange failed:', e.message);
  }
}

/**
 * Sweeps every subscription that could have a reminder due today: ends within
 * the next 7 days, or lapsed within the catch-up window. Lifetime rows have no
 * end_date, so they never match. Returns { checked, created }.
 */
async function runExpiryCheck(now = new Date()) {
  const today = sub.todayString(now);
  const from = sub.addDays(today, -sub.EXPIRED_NOTICE_WINDOW_DAYS);
  const to = sub.addDays(today, Math.max(...sub.NOTICE_THRESHOLDS));

  let checked = 0;
  let created = 0;
  for (let offset = 0; ; offset += PAGE) {
    const { data: rows, error } = await supabase
      .from('subscriptions')
      .select('user_id, is_lifetime, start_date, end_date, is_trial, expires_at')
      .eq('is_lifetime', false)
      .gte('end_date', from)
      .lte('end_date', to)
      .lte('start_date', today)
      .order('end_date', { ascending: true })
      .order('user_id', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!rows || rows.length === 0) break;

    const { data: users, error: userErr } = await supabase
      .from('app_users')
      .select('id, email, status')
      .in('id', rows.map((r) => r.user_id));
    if (userErr) throw new Error(userErr.message);
    const byId = new Map((users || []).map((u) => [u.id, u]));

    for (const r of rows) {
      const user = byId.get(r.user_id);
      if (!user || user.status !== 'approved') continue; // can't log in -> nobody to tell
      checked++;
      if (await ensureForSubscription(r, user, today)) created++;
    }
    if (rows.length < PAGE) break;
  }
  return { today, checked, created };
}

let _timer = null;
let _running = false;

/**
 * Hourly in-process sweep. Only runs while this instance is awake -- on
 * Render's free tier that's not "always", which is why the endpoint + the
 * lazy per-user path above exist.
 */
function startScheduler() {
  if (_timer) return;
  const every = Number(process.env.SUBSCRIPTION_CHECK_INTERVAL_MS) || 60 * 60 * 1000;
  const tick = async () => {
    if (_running) return;
    _running = true;
    try {
      const r = await runExpiryCheck();
      if (r.created) console.log(`[subscriptions] expiry check: ${r.created} new notification(s)`);
    } catch (e) {
      console.error('[subscriptions] expiry check failed:', e.message);
    } finally {
      _running = false;
    }
  };
  setTimeout(tick, 30 * 1000).unref?.(); // shortly after boot, once the server is up
  _timer = setInterval(tick, every);
  _timer.unref?.();
}

module.exports = { ensureForSubscription, ensureForUser, notifyChange, runExpiryCheck, startScheduler };
