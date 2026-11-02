'use strict';
process.env.JWT_SECRET = 'test-secret';
process.env.SUBSCRIPTION_TZ = 'Asia/Kolkata';
process.env.SUBSCRIPTION_CRON_SECRET = 'cron-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { create } = require('./fakeSupabase');

// Swap the real Supabase client for the in-memory fake BEFORE loading routes.
const fake = create();
const clientPath = require.resolve('../lib/supabaseClient');
require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: fake };

const mailer = require('../lib/mailer');
const emails = [];
mailer.sendSubscriptionEmail = async (to, subject, text) => { emails.push({ to, subject, text }); };

const S = require('../lib/subscription');
const notifier = require('../lib/subscriptionNotifier');
const routes = require('../routes/subscriptions');

const today = S.todayString();
const d = (n) => S.addDays(today, n);

const mkUser = (email, role = 'listener', status = 'approved', name = null) => {
  const u = { id: fake.uuid(), email, display_name: name ?? email.split('@')[0], role, status, created_at: new Date().toISOString() };
  fake.db.app_users.push(u);
  return u;
};
const adminU = mkUser('admin@x.com', 'admin');
const alice = mkUser('alice@x.com');
const bob = mkUser('bob@x.com');
const carol = mkUser('carol@x.com');
const pending = mkUser('pending@x.com', 'listener', 'pending');
const tok = (u) => jwt.sign({ sub: u.id, email: u.email, role: u.role }, process.env.JWT_SECRET);

let server;
let base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/subscriptions', routes);
  app.use((err, req, res, next) => res.status(500).json({ error: err.message })); // mirrors server.js
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}/api/subscriptions`;
});
test.after(() => server.close());

async function call(method, url, user, body, headers = {}) {
  const r = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${tok(user)}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

test('auth: anonymous 401, listener 403 on admin routes', async () => {
  assert.equal((await call('GET', '/', null)).status, 401);
  assert.equal((await call('GET', '/', alice)).status, 403);
  assert.equal((await call('POST', `/${alice.id}/assign`, alice, { plan: 30 })).status, 403);
  assert.equal((await call('GET', '/me', null)).status, 401);
});

test('a listener with no subscription sees status none', async () => {
  const r = await call('GET', '/me', alice);
  assert.equal(r.status, 200);
  assert.equal(r.body.subscription.status, 'none');
  assert.equal(r.body.unreadCount, 0);
});

test('assign: every plan computes the end date; admin and listener see the same thing', async () => {
  for (const [plan, days] of [[30, 30], [90, 90], [180, 180], [365, 365]]) {
    const r = await call('POST', `/${alice.id}/assign`, adminU, { plan, startDate: today });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.subscription.endDate, d(days));
    assert.equal(r.body.subscription.totalDays, days);
    assert.equal(r.body.subscription.daysRemaining, days);
    assert.equal(r.body.subscription.status, 'active');
  }
  const mine = await call('GET', '/me', alice);
  const theirs = await call('GET', `/${alice.id}`, adminU);
  assert.deepEqual(mine.body.subscription, theirs.body.subscription);
  assert.equal(mine.body.subscription.endDate, d(365));
  assert.equal(fake.db.subscriptions.filter((s) => s.user_id === alice.id).length, 1); // one row per user
});

test('assign: custom (past / future) start dates, lifetime, and validation', async () => {
  const past = await call('POST', `/${bob.id}/assign`, adminU, { plan: 30, startDate: d(-60) });
  assert.equal(past.body.subscription.status, 'expired');
  assert.equal(past.body.subscription.daysRemaining, 0);

  const future = await call('POST', `/${bob.id}/assign`, adminU, { plan: 30, startDate: d(10) });
  assert.equal(future.body.subscription.status, 'upcoming');
  assert.equal(future.body.subscription.startsInDays, 10);
  assert.equal(future.body.subscription.endDate, d(40));

  const life = await call('POST', `/${bob.id}/assign`, adminU, { plan: 'lifetime', startDate: today });
  assert.equal(life.body.subscription.status, 'lifetime');
  assert.equal(life.body.subscription.endDate, null);
  assert.equal(life.body.subscription.daysRemaining, null);

  for (const bad of [{ plan: 45 }, { plan: 'forever' }, {}, { plan: 30, startDate: '2026-02-31' }, { plan: 30, startDate: 'tomorrow' }, { plan: 30, startDate: '1990-01-01' }]) {
    assert.equal((await call('POST', `/${bob.id}/assign`, adminU, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call('POST', `/not-a-uuid/assign`, adminU, { plan: 30 })).status, 400);
  assert.equal((await call('POST', `/${fake.uuid()}/assign`, adminU, { plan: 30 })).status, 404);
  assert.equal((await call('POST', `/${adminU.id}/assign`, adminU, { plan: 30 })).status, 404); // admins aren't listeners
});

test('assign defaults the start date to today', async () => {
  const r = await call('POST', `/${carol.id}/assign`, adminU, { plan: 90 });
  assert.equal(r.body.subscription.startDate, today);
  assert.equal(r.body.subscription.endDate, d(90));
});

test('assign then renew records the right history actions', async () => {
  const hist = (await call('GET', `/${carol.id}`, adminU)).body.history;
  assert.deepEqual(hist.map((h) => h.action), ['assigned']);
  await call('POST', `/${carol.id}/renew`, adminU, { plan: 30, startDate: today });
  const after = (await call('GET', `/${carol.id}`, adminU)).body;
  assert.deepEqual(after.history.map((h) => h.action).sort(), ['assigned', 'renewed']);
  assert.equal(after.history[0].performedBy, 'admin');
  assert.equal(after.subscription.endDate, d(30)); // renew REPLACED the 90-day term
});

test('extend: active adds days, expired restarts today, lifetime/none refused', async () => {
  await call('POST', `/${carol.id}/assign`, adminU, { plan: 30, startDate: today });
  const e1 = await call('POST', `/${carol.id}/extend`, adminU, { days: 15 });
  assert.equal(e1.body.subscription.endDate, d(45));
  assert.equal(e1.body.subscription.startDate, today);
  assert.equal(e1.body.subscription.totalDays, 45);

  await call('POST', `/${carol.id}/assign`, adminU, { plan: 30, startDate: d(-90) }); // long expired
  const e2 = await call('POST', `/${carol.id}/extend`, adminU, { days: 30 });
  assert.equal(e2.body.subscription.status, 'active');
  assert.equal(e2.body.subscription.startDate, today);
  assert.equal(e2.body.subscription.endDate, d(30));

  await call('POST', `/${carol.id}/assign`, adminU, { plan: 'lifetime' });
  assert.equal((await call('POST', `/${carol.id}/extend`, adminU, { days: 30 })).status, 400);
  for (const bad of [0, -5, 1.5, 'abc', 99999, undefined]) {
    assert.equal((await call('POST', `/${carol.id}/extend`, adminU, { days: bad })).status, 400, String(bad));
  }
  const fresh = mkUser('fresh@x.com');
  assert.equal((await call('POST', `/${fresh.id}/extend`, adminU, { days: 5 })).status, 404);
});

test('modify: change plan, set dates, note-only, and validation', async () => {
  const u = mkUser('modify@x.com');
  await call('POST', `/${u.id}/assign`, adminU, { plan: 30, startDate: today });

  const plan = await call('PATCH', `/${u.id}`, adminU, { plan: 90 });
  assert.equal(plan.body.subscription.endDate, d(90));

  const end = await call('PATCH', `/${u.id}`, adminU, { endDate: d(10) });
  assert.equal(end.body.subscription.endDate, d(10));
  assert.equal(end.body.subscription.status, 'active');         // 10 days left: outside the 7-day window
  assert.equal(end.body.subscription.daysRemaining, 10);
  const soon = await call('PATCH', `/${u.id}`, adminU, { endDate: d(5) });
  assert.equal(soon.body.subscription.status, 'expiring_soon');  // 5 days left
  assert.equal(soon.body.subscription.daysRemaining, 5);
  await call('PATCH', `/${u.id}`, adminU, { endDate: d(10) });  // restore for the steps below

  assert.equal((await call('PATCH', `/${u.id}`, adminU, { endDate: d(-5) })).status, 400); // before start
  assert.equal((await call('PATCH', `/${u.id}`, adminU, { startDate: d(20) })).status, 400); // after end
  assert.equal((await call('PATCH', `/${u.id}`, adminU, {})).status, 400);

  const before = fake.db.user_notifications.filter((n) => n.user_id === u.id).length;
  const note = await call('PATCH', `/${u.id}`, adminU, { note: 'paid cash' });
  assert.equal(note.body.subscription.note, 'paid cash');
  assert.equal(fake.db.user_notifications.filter((n) => n.user_id === u.id).length, before); // note-only: listener not told

  const life = await call('PATCH', `/${u.id}`, adminU, { plan: 'lifetime' });
  assert.equal(life.body.subscription.status, 'lifetime');
  const back = await call('PATCH', `/${u.id}`, adminU, { endDate: d(50) }); // lifetime -> fixed end
  assert.equal(back.body.subscription.isLifetime, false);
  assert.equal(back.body.subscription.endDate, d(50));
});

test('listener inbox: admin changes show up, unread count, mark read', async () => {
  const u = mkUser('inbox@x.com');
  await call('POST', `/${u.id}/assign`, adminU, { plan: 30 });
  const me = await call('GET', '/me', u);
  assert.equal(me.body.unreadCount, 1);
  const list = await call('GET', '/me/notifications', u);
  assert.equal(list.body.notifications.length, 1);
  assert.equal(list.body.notifications[0].kind, 'subscription_updated');
  assert.match(list.body.notifications[0].body, /30 days remaining/);

  assert.equal((await call('POST', '/me/notifications/read', u, {})).status, 400);
  assert.equal((await call('POST', '/me/notifications/read', u, { ids: ['nope'] })).status, 400);
  await call('POST', '/me/notifications/read', u, { ids: [list.body.notifications[0].id] });
  assert.equal((await call('GET', '/me', u)).body.unreadCount, 0);

  // another user's notification can't be marked read through my account
  const other = fake.db.user_notifications.find((n) => n.user_id !== u.id && !n.read_at);
  await call('POST', '/me/notifications/read', u, { ids: [other.id] });
  assert.equal(other.read_at, null);
});

test('reminders: 7 / 3 / 1 days and expiry, once each, email once; extending starts a new cycle', async () => {
  const u = mkUser('remind@x.com');
  emails.length = 0;
  const kinds = () => fake.db.user_notifications.filter((n) => n.user_id === u.id && n.kind !== 'subscription_updated').map((n) => n.kind);

  await call('POST', `/${u.id}/assign`, adminU, { plan: 30, startDate: d(-23) }); // 7 days left
  await call('GET', '/me', u);
  await call('GET', '/me', u); // opening the app twice must not duplicate
  assert.deepEqual(kinds(), ['expiry_7']);
  assert.equal(emails.length, 1);
  assert.match(emails[0].text, /7 days remaining/);

  await call('PATCH', `/${u.id}`, adminU, { endDate: d(3) });
  await call('GET', '/me', u);
  assert.deepEqual(kinds(), ['expiry_7', 'expiry_3']);

  await call('PATCH', `/${u.id}`, adminU, { endDate: d(1) });
  await call('GET', '/me', u);
  assert.deepEqual(kinds(), ['expiry_7', 'expiry_3', 'expiry_1']);

  await call('PATCH', `/${u.id}`, adminU, { endDate: d(0) });
  await call('GET', '/me', u); // expires today -> same expiry_1 kind but a NEW end date => new key
  assert.equal(kinds().filter((k) => k === 'expiry_1').length, 2);

  await call('POST', `/${u.id}/assign`, adminU, { plan: 30, startDate: d(-31) }); // ended yesterday
  await call('GET', '/me', u);
  assert.ok(kinds().includes('expired'));
  assert.equal(emails.at(-1).subject, 'Your subscription has expired');

  // extend out of the window: nothing due, no new reminder
  const n = kinds().length;
  await call('POST', `/${u.id}/extend`, adminU, { days: 60 });
  await call('GET', '/me', u);
  assert.equal(kinds().length, n);
});

test('no reminders for lifetime or healthy subscriptions', async () => {
  const u = mkUser('quiet@x.com');
  await call('POST', `/${u.id}/assign`, adminU, { plan: 'lifetime' });
  await call('GET', '/me', u);
  await call('POST', `/${u.id}/assign`, adminU, { plan: 365 });
  await call('GET', '/me', u);
  assert.equal(fake.db.user_notifications.filter((n) => n.user_id === u.id && n.kind !== 'subscription_updated').length, 0);
});

test('cron sweep: secret required; creates reminders for approved users only; idempotent', async () => {
  const a = mkUser('cron-a@x.com');
  const b = mkUser('cron-b@x.com');
  const p = mkUser('cron-pending@x.com', 'listener', 'pending');
  for (const [u, end] of [[a, d(5)], [b, d(-1)], [p, d(5)]]) {
    fake.db.subscriptions.push({ id: fake.uuid(), user_id: u.id, is_lifetime: false, start_date: d(-30), end_date: end, note: null });
  }
  assert.equal((await call('POST', '/cron/run', null, {})).status, 401);
  assert.equal((await call('POST', '/cron/run', null, {}, { 'x-cron-secret': 'wrong' })).status, 401);
  const ok = await call('POST', '/cron/run', null, {}, { 'x-cron-secret': 'cron-secret' });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.created >= 2);
  const mine = (u) => fake.db.user_notifications.filter((n) => n.user_id === u.id).map((n) => n.kind);
  assert.deepEqual(mine(a), ['expiry_7']);
  assert.deepEqual(mine(b), ['expired']);
  assert.deepEqual(mine(p), []); // pending signup can't log in
  const again = await call('POST', '/cron/run', null, {}, { 'x-cron-secret': 'cron-secret' });
  assert.equal(again.body.created, 0);
  delete process.env.SUBSCRIPTION_CRON_SECRET;
  assert.equal((await call('POST', '/cron/run', null, {}, { 'x-cron-secret': 'cron-secret' })).status, 404);
  process.env.SUBSCRIPTION_CRON_SECRET = 'cron-secret';
});

test('admin list: filters, summary, search, paging, expired clearly flagged', async () => {
  fake.db.subscriptions.length = 0;
  fake.db.app_users.length = 0;
  const admin2 = mkUser('boss@x.com', 'admin');
  const mk = (name, row) => {
    const u = mkUser(`${name}@x.com`, 'listener', 'approved', name);
    if (row) fake.db.subscriptions.push({ id: fake.uuid(), user_id: u.id, note: null, ...row });
    return u;
  };
  mk('active1', { is_lifetime: false, start_date: d(-5), end_date: d(25) });
  mk('active2', { is_lifetime: false, start_date: d(-5), end_date: d(100) });
  mk('soon1', { is_lifetime: false, start_date: d(-25), end_date: d(5) });
  mk('soon2', { is_lifetime: false, start_date: d(-30), end_date: d(0) });
  mk('gone1', { is_lifetime: false, start_date: d(-60), end_date: d(-1) });
  mk('forever', { is_lifetime: true, start_date: d(-100), end_date: null });
  mk('later', { is_lifetime: false, start_date: d(5), end_date: d(35) });
  mk('nosub1');
  mk('nosub2');
  mkUser('pend@x.com', 'listener', 'pending');

  const all = await call('GET', '/?limit=100', admin2);
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.summary, { all: 9, active: 2, trial: 0, expiring: 2, expired: 1, lifetime: 1, upcoming: 1, none: 2 });
  assert.equal(all.body.total, 9);

  const names = async (q) => (await call('GET', '/?' + q, admin2)).body.users.map((u) => u.displayName);
  assert.deepEqual((await names('status=expired')), ['gone1']);
  assert.deepEqual((await names('status=expiring')).sort(), ['soon1', 'soon2']);
  assert.deepEqual((await names('status=expiring'))[0], 'soon2'); // soonest first
  assert.deepEqual((await names('status=lifetime')), ['forever']);
  assert.deepEqual((await names('status=upcoming')), ['later']);
  assert.deepEqual((await names('status=none')).sort(), ['nosub1', 'nosub2']);
  assert.deepEqual((await names('status=active')).sort(), ['active1', 'active2']);
  assert.deepEqual((await names('q=SOON')).sort(), ['soon1', 'soon2']);
  // Characters that could alter a PostgREST filter are stripped from the search term. What's left
  // here is empty, so the list is simply unfiltered -- and, importantly, nothing errors or injects.
  const hostile = await call('GET', '/?limit=100&q=' + encodeURIComponent('%,()'), admin2);
  assert.equal(hostile.status, 200);
  assert.equal(hostile.body.users.length, 9);
  const mixed = await call('GET', '/?q=' + encodeURIComponent('soon1),email.neq.x'), admin2);
  assert.equal(mixed.status, 200); // becomes the harmless literal "soon1email.neq.x" -> no matches
  assert.equal(mixed.body.users.length, 0);

  const expired = (await call('GET', '/?status=expired', admin2)).body.users[0];
  assert.equal(expired.subscription.status, 'expired');
  assert.equal(expired.subscription.expiredDaysAgo, 1);

  const p1 = await call('GET', '/?limit=4&offset=0', admin2);
  const p2 = await call('GET', '/?limit=4&offset=4', admin2);
  assert.equal(p1.body.users.length, 4);
  assert.equal(p2.body.users.length, 4);
  assert.equal(p2.body.summary, null); // summary only on page 1
  const ids = new Set([...p1.body.users, ...p2.body.users].map((u) => u.userId));
  assert.equal(ids.size, 8);
});

test('remove subscription', async () => {
  const u = fake.db.app_users.find((x) => x.email === 'gone1@x.com');
  const r = await call('DELETE', `/${u.id}`, fake.db.app_users.find((x) => x.role === 'admin'));
  assert.equal(r.status, 200);
  assert.equal(r.body.subscription.status, 'none');
  assert.equal((await call('DELETE', `/${u.id}`, fake.db.app_users.find((x) => x.role === 'admin'))).status, 404);
  const detail = await call('GET', `/${u.id}`, fake.db.app_users.find((x) => x.role === 'admin'));
  assert.equal(detail.body.history[0].action, 'removed');
});
