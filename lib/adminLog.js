/**
 * Admin activity log: who did what to whom, and when.
 * Every admin mutation (subscription, trial, device) calls logAdmin().
 * Logging never fails the action it describes -- the action has already
 * happened -- but a failure is printed loudly so it is not silent.
 */
'use strict';

const supabase = require('./supabaseClient');

/**
 * @param req     the Express request of the admin (req.user = JWT payload)
 * @param action  dotted name, e.g. 'subscription.assign', 'device.block'
 * @param target  { id, email } of the affected listener (optional)
 * @param details small JSON-able object (plan, days, device id, ...)
 */
async function logAdmin(req, action, target, details = {}) {
  try {
    const { error } = await supabase.from('admin_activity_log').insert({
      admin_id: req.user?.sub ?? null,
      admin_email: req.user?.email ?? null,
      action,
      target_user_id: target?.id ?? null,
      target_email: target?.email ?? null,
      details,
      ip: req.ip ?? null,
    });
    if (error) console.error('[admin-log] insert failed:', error.message);
  } catch (e) {
    console.error('[admin-log] failed:', e.message);
  }
}

module.exports = { logAdmin };
