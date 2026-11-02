'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/subscription');

const row = (start, end, life = false) => ({ start_date: start, end_date: end, is_lifetime: life });

test('date helpers: validation, add, diff', () => {
  assert.equal(S.isValidDate('2026-02-28'), true);
  assert.equal(S.isValidDate('2026-02-31'), false); // would roll into March
  assert.equal(S.isValidDate('2024-02-29'), true);  // leap day
  assert.equal(S.isValidDate('2025-02-29'), false);
  assert.equal(S.isValidDate('26-1-1'), false);
  assert.equal(S.isValidDate(20260101), false);
  assert.equal(S.addDays('2026-01-01', 30), '2026-01-31');
  assert.equal(S.addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(S.addDays('2024-02-28', 2), '2024-03-01');
  assert.equal(S.addDays('2026-01-01', 365), '2027-01-01');
  assert.equal(S.addDays('2024-01-01', 365), '2024-12-31'); // leap year
  assert.equal(S.diffDays('2026-03-01', '2026-02-01'), 28);
  assert.equal(S.diffDays('2026-01-01', '2026-01-05'), -4);
});

test('end date is start + duration for every offered plan; lifetime has none', () => {
  for (const [input, end] of [[30, '2026-01-31'], ['90', '2026-04-01'], [180, '2026-06-30'], ['365', '2027-01-01']]) {
    const plan = S.parsePlan(input);
    assert.ok(plan, `plan ${input}`);
    assert.equal(S.computeEndDate('2026-01-01', plan), end);
  }
  const life = S.parsePlan('Lifetime');
  assert.deepEqual(life, { lifetime: true });
  assert.equal(S.computeEndDate('2026-01-01', life), null);
});

test('only the five offered plans parse', () => {
  for (const bad of [0, 7, 31, '45', 'forever', '', null, undefined, -30, '30.5', {}]) {
    assert.equal(S.parsePlan(bad), null, String(bad));
  }
});

test('status transitions across a 30-day term (Jan 1 -> Jan 31)', () => {
  const r = row('2026-01-01', '2026-01-31');
  const at = (d) => S.deriveState(r, d);
  assert.equal(at('2025-12-31').status, 'upcoming');
  assert.equal(at('2025-12-31').startsInDays, 1);
  assert.deepEqual([at('2026-01-01').status, at('2026-01-01').daysRemaining, at('2026-01-01').totalDays], ['active', 30, 30]);
  assert.deepEqual([at('2026-01-23').status, at('2026-01-23').daysRemaining], ['active', 8]);
  assert.deepEqual([at('2026-01-24').status, at('2026-01-24').daysRemaining], ['expiring_soon', 7]);
  assert.deepEqual([at('2026-01-31').status, at('2026-01-31').daysRemaining], ['expiring_soon', 0]); // last valid day
  assert.deepEqual([at('2026-02-01').status, at('2026-02-01').daysRemaining, at('2026-02-01').expiredDaysAgo], ['expired', 0, 1]);
  assert.equal(at('2026-06-01').status, 'expired');
});

test('lifetime never expires and has no remaining-days number', () => {
  const r = row('2020-01-01', null, true);
  for (const d of ['2020-01-01', '2026-11-01', '2199-01-01']) {
    const s = S.deriveState(r, d);
    assert.equal(s.status, 'lifetime');
    assert.equal(s.daysRemaining, null);
    assert.equal(s.totalDays, null);
  }
  assert.equal(S.deriveState(row('2030-01-01', null, true), '2026-01-01').status, 'upcoming');
});

test('no subscription -> none', () => {
  assert.equal(S.deriveState(null, '2026-01-01').status, 'none');
  const p = S.toPublic(null, '2026-01-01');
  assert.equal(p.status, 'none');
  assert.equal(p.endDate, null);
});

test('toPublic shape', () => {
  const p = S.toPublic({ ...row('2026-01-01', '2026-04-01'), note: 'x', updated_at: 't' }, '2026-02-01');
  assert.deepEqual(p, {
    status: 'active', plan: 'custom', isLifetime: false, isTrial: false, startDate: '2026-01-01', endDate: '2026-04-01',
    expiresAt: null, totalDays: 90, daysRemaining: 59, hoursRemaining: null, startsInDays: 0, expiredDaysAgo: null,
    entitled: true, entitlementReason: 'active', validUntil: S.toPublic({ ...row('2026-01-01', '2026-04-01') }, '2026-02-01').validUntil,
    note: 'x', updatedAt: 't',
  });
});

test('extend: active adds to current end; expired restarts from today; lifetime refused', () => {
  const active = S.extendTerm(row('2026-01-01', '2026-01-31'), 30, '2026-01-20');
  assert.deepEqual(active, { is_lifetime: false, start_date: '2026-01-01', end_date: '2026-03-02' });

  const upcoming = S.extendTerm(row('2026-03-01', '2026-03-31'), 10, '2026-01-20');
  assert.equal(upcoming.end_date, '2026-04-10');
  assert.equal(upcoming.start_date, '2026-03-01');

  const onLastDay = S.extendTerm(row('2026-01-01', '2026-01-31'), 30, '2026-01-31');
  assert.equal(onLastDay.end_date, '2026-03-02'); // not expired yet -> nothing lost

  const expired = S.extendTerm(row('2025-01-01', '2025-01-31'), 30, '2026-01-20');
  assert.deepEqual(expired, { is_lifetime: false, start_date: '2026-01-20', end_date: '2026-02-19' });

  assert.match(S.extendTerm(row('2020-01-01', null, true), 30, '2026-01-20').error, /lifetime/i);
});

test('todayString uses the configured timezone, not UTC', () => {
  const t = new Date('2026-11-01T20:00:00Z'); // 01:30 on 2 Nov in IST, still 1 Nov in UTC
  assert.equal(S.todayString(t, 'Asia/Kolkata'), '2026-11-02');
  assert.equal(S.todayString(t, 'UTC'), '2026-11-01');
  assert.equal(S.todayString(t, 'America/Los_Angeles'), '2026-11-01');
  assert.match(S.todayString(t, 'Not/AZone'), /^\d{4}-\d{2}-\d{2}$/); // bad tz falls back, never throws
});

test('reminders fire at 7 / 3 / 1 days, then expiry; one most-urgent notice at a time', () => {
  const r = row('2026-01-01', '2026-01-31');
  const kind = (d) => S.dueNotice(r, d)?.kind ?? null;
  assert.equal(kind('2026-01-23'), null);          // 8 left
  assert.equal(kind('2026-01-24'), 'expiry_7');    // 7 left
  assert.equal(kind('2026-01-27'), 'expiry_7');    // 4 left
  assert.equal(kind('2026-01-28'), 'expiry_3');    // 3 left
  assert.equal(kind('2026-01-29'), 'expiry_3');    // 2 left (job missed the 3-day mark: no burst, just one)
  assert.equal(kind('2026-01-30'), 'expiry_1');    // 1 left
  assert.equal(kind('2026-01-31'), 'expiry_1');    // 0 left = expires today
  assert.equal(kind('2026-02-01'), 'expired');
  assert.equal(kind('2026-02-03'), 'expired');     // 3rd day after: last day of the catch-up window
  assert.equal(kind('2026-02-04'), null);          // long dead: stay quiet
});

test('no reminders for lifetime, none-yet, or not-yet-started terms', () => {
  assert.equal(S.dueNotice(row('2020-01-01', null, true), '2026-01-01'), null);
  assert.equal(S.dueNotice(null, '2026-01-01'), null);
  assert.equal(S.dueNotice(row('2026-02-01', '2026-02-05'), '2026-01-31'), null);
});

test('extending creates a fresh reminder cycle via the end-date dedupe key', () => {
  assert.notEqual(S.dedupeKey('u1', 'expiry_7', '2026-01-31'), S.dedupeKey('u1', 'expiry_7', '2026-03-02'));
  assert.equal(S.dedupeKey('u1', 'expiry_7', '2026-01-31'), S.dedupeKey('u1', 'expiry_7', '2026-01-31'));
});

test('notice wording includes remaining days and handles singular / today / tomorrow', () => {
  const n = (kind, daysLeft) => S.buildNotice({ kind, daysLeft, endDate: '2026-01-31' });
  assert.equal(n('expiry_7', 7).title, 'Your subscription expires in 7 days');
  assert.match(n('expiry_7', 7).body, /31 Jan 2026.*7 days remaining/);
  assert.match(n('expiry_3', 3).body, /3 days remaining/);
  assert.equal(n('expiry_1', 1).title, 'Your subscription expires tomorrow');
  assert.match(n('expiry_1', 1).body, /1 day remaining/);
  assert.equal(n('expiry_1', 0).title, 'Your subscription expires today');
  assert.equal(n('expired', 0).title, 'Your subscription has expired');
});

test('update notice wording', () => {
  const pub = S.toPublic(row('2026-01-01', '2026-01-31'), '2026-01-01');
  assert.match(S.buildUpdateNotice('assigned', pub).body, /ends on 31 Jan 2026 \(30 days remaining\)/);
  const life = S.toPublic(row('2026-01-01', null, true), '2026-01-01');
  assert.match(S.buildUpdateNotice('renewed', life).body, /Lifetime Access/);
  assert.equal(S.buildUpdateNotice('removed', S.toPublic(null, '2026-01-01')).title, 'Subscription removed');
  const up = S.toPublic(row('2026-03-01', '2026-03-31'), '2026-01-01');
  assert.match(S.buildUpdateNotice('assigned', up).body, /starts on 1 Mar 2026/);
});

test('date bounds', () => {
  assert.equal(S.dateInBounds('2026-05-05'), true);
  assert.equal(S.dateInBounds('1999-12-31'), false);
  assert.equal(S.dateInBounds('2201-01-01'), false);
});

// ======================= free trial, entitlement, email canonicalisation =======================

const trialRow = (expiresAt, start = '2026-11-01', end = '2026-11-04') => ({
  is_lifetime: false, is_trial: true, plan: 'trial', start_date: start, end_date: end, expires_at: expiresAt,
});

test('trial: exactly 72 hours, judged by the instant not the calendar day', () => {
  const claimed = new Date('2026-11-01T10:00:00Z');
  const expires = new Date(claimed.getTime() + S.TRIAL_HOURS * 3600e3).toISOString();
  assert.equal(S.TRIAL_HOURS, 72);
  const r = trialRow(expires);
  const at = (iso) => S.deriveState(r, '2026-11-01', new Date(iso));
  assert.equal(at('2026-11-01T10:00:01Z').status, 'trial');
  assert.equal(at('2026-11-01T10:00:01Z').daysRemaining, 3);
  assert.equal(at('2026-11-04T09:59:59Z').status, 'trial');       // 1 s left
  assert.equal(at('2026-11-04T09:59:59Z').daysRemaining, 1);
  assert.equal(at('2026-11-04T09:59:59Z').hoursRemaining, 1);
  assert.equal(at('2026-11-04T10:00:00Z').status, 'expired');     // the instant it ends
  assert.equal(at('2026-11-04T10:00:01Z').daysRemaining, 0);
});

test('entitlement: every status maps to the right yes/no and reason', () => {
  const now = new Date('2026-11-10T06:00:00Z');
  const today = S.todayString(now, 'Asia/Kolkata'); // 2026-11-10
  const e = (row) => S.entitlement(row, today, now);
  assert.deepEqual(e(null), { entitled: false, reason: 'none', validUntil: null });
  assert.equal(e(row('2026-11-01', '2026-12-01')).entitled, true);
  assert.equal(e(row('2026-11-01', '2026-12-01')).reason, 'active');
  assert.equal(e(row('2026-11-01', '2026-11-10')).entitled, true);           // valid through its last day
  assert.equal(e(row('2026-10-01', '2026-11-09')).reason, 'expired');
  assert.equal(e(row('2026-11-20', '2026-12-20')).reason, 'upcoming');
  assert.equal(e(row('2020-01-01', null, true)).reason, 'lifetime');
  assert.equal(e(trialRow('2026-11-11T00:00:00Z')).reason, 'trial');
  assert.equal(e(trialRow('2026-11-09T00:00:00Z')).reason, 'trial_expired');
  assert.equal(e(trialRow('2026-11-09T00:00:00Z')).entitled, false);
});

test('validUntil is the start of the NEXT day in the business time zone (IST), as a UTC instant', () => {
  const now = new Date('2026-11-10T06:00:00Z');
  const e = S.entitlement(row('2026-11-01', '2026-11-30'), '2026-11-10', now, 'Asia/Kolkata');
  assert.equal(e.validUntil, '2026-11-30T18:30:00.000Z'); // 00:00 IST on 1 Dec
  const ny = S.zonedMidnightUtcMs('2026-03-09', 'America/New_York'); // day after US DST began
  assert.equal(new Date(ny).toISOString(), '2026-03-09T04:00:00.000Z');
  assert.equal(new Date(S.zonedMidnightUtcMs('2026-03-08', 'America/New_York')).toISOString(), '2026-03-08T05:00:00.000Z');
});

test('normalizeEmail: Gmail dots/+tags/googlemail collapse; other domains keep dots but lose +tags', () => {
  const n = S.normalizeEmail;
  assert.equal(n('  John.Doe+promo@Gmail.com '), 'johndoe@gmail.com');
  assert.equal(n('j.o.h.n.d.o.e@googlemail.com'), 'johndoe@gmail.com');
  assert.equal(n('John.Doe@corp.co.in'), 'john.doe@corp.co.in');
  assert.equal(n('a+b+c@corp.in'), 'a@corp.in');
  for (const bad of ['', 'plain', '@x.com', 'a@', null, undefined, 42, '+tag@x.com']) assert.equal(n(bad), null, String(bad));
});

test('plan ranking: upgrade / downgrade / neither', () => {
  assert.equal(S.planChangeAction('trial', '30'), 'upgraded');
  assert.equal(S.planChangeAction('30', '365'), 'upgraded');
  assert.equal(S.planChangeAction('365', 'lifetime'), 'upgraded');
  assert.equal(S.planChangeAction('lifetime', '90'), 'downgraded');
  assert.equal(S.planChangeAction('180', '30'), 'downgraded');
  assert.equal(S.planChangeAction('90', '90'), null);
  assert.equal(S.planChangeAction('custom', '90'), null);
  assert.deepEqual(S.PLAN_ORDER, ['trial', '30', '90', '180', '365', 'lifetime']);
});

test('parsePlan accepts exactly the six plans', () => {
  for (const ok of ['trial', 30, '90', 180, '365', 'lifetime', 'LIFETIME']) assert.ok(S.parsePlan(ok), String(ok));
  for (const bad of [0, 7, 45, 'forever', 'trial2', null, undefined, {}]) assert.equal(S.parsePlan(bad), null, String(bad));
});

test('trial: no countdown reminders (they would all fire on day one), one "ended" note after expiry', () => {
  const now = new Date('2026-11-05T00:00:00Z');
  const live = trialRow('2026-11-06T00:00:00Z');
  assert.equal(S.dueNotice(live, '2026-11-05', now), null);
  const dead = trialRow('2026-11-04T10:00:00Z');
  const n = S.dueNotice(dead, '2026-11-05', now);
  assert.equal(n.kind, 'trial_expired');
  assert.match(S.buildNotice(n).title, /free trial has ended/i);
  assert.equal(S.dueNotice(trialRow('2026-10-01T00:00:00Z'), '2026-11-05', now), null); // long dead: no note
});

test('a trial cannot be extended', () => {
  assert.match(S.extendTerm(trialRow('2026-11-04T10:00:00Z'), 30, '2026-11-02').error, /trial/i);
});
