-- SwarKatha TEST DATA. Run in the Supabase SQL editor to create dummy listeners
-- in every subscription / trial / device state, so you can try the apps and the
-- admin dashboard. Safe to re-run (it deletes and recreates its own users).
--
--   Every test user's password:  Test@1234
--   Every test email ends with:  @test.swarkatha
--
-- Run supabase/cleanup_test_data.sql to remove it all again.
-- Needs migration_trials_devices.sql to have been run first.

-- ---- start clean (only touches @test.swarkatha) ----
delete from trial_claims where email_normalized like '%@test.swarkatha';
delete from app_users    where email like '%@test.swarkatha';   -- cascades subscriptions, history, devices

-- ---- the users ----
insert into app_users (id, email, password_hash, display_name, role, status, device_limit) values
 ('00000000-0000-4000-8000-000000000001', 'none@test.swarkatha',          '$2a$10$c2gpYlk2z5F41dzbXav8COti7mwrfjnXgiCFDTHI8EFz0bQUbVB/C', 'Test: no plan (can start trial)',   'listener', 'approved', 1),
 ('00000000-0000-4000-8000-000000000002', 'trial-running@test.swarkatha', '$2a$10$c2gpYlk2z5F41dzbXav8COti7mwrfjnXgiCFDTHI8EFz0bQUbVB/C', 'Test: trial running (~2 days)',     'listener', 'approved', 1),
 ('00000000-0000-4000-8000-000000000003', 'trial-ending@test.swarkatha',  '$2a$10$c2gpYlk2z5F41dzbXav8COti7mwrfjnXgiCFDTHI8EFz0bQUbVB/C', 'Test: trial ends in ~3 hours',      'listener', 'approved', 1),
 ('00000000-0000-4000-8000-000000000004', 'trial-expired@test.swarkatha', '$2a$10$c2gpYlk2z5F41dzbXav8COti7mwrfjnXgiCFDTHI8EFz0bQUbVB/C', 'Test: trial expired',               'listener', 'approved', 1),
 ('00000000-0000-4000-8000-000000000005', 'active-90@test.swarkatha',     '$2a$10$c2gpYlk2z5F41dzbXav8COti7mwrfjnXgiCFDTHI8EFz0bQUbVB/C', 'Test: 90-day plan active',          'listener', 'approved', 1),
 ('00000000-0000-4000-8000-000000000006', 'expiring@test.swarkatha',      '$2a$10$c2gpYlk2z5F41dzbXav8COti7mwrfjnXgiCFDTHI8EFz0bQUbVB/C', 'Test: 30-day plan, 3 days left',    'listener', 'approved', 1),
 ('00000000-0000-4000-8000-000000000007', 'expired-30@test.swarkatha',    '$2a$10$c2gpYlk2z5F41dzbXav8COti7mwrfjnXgiCFDTHI8EFz0bQUbVB/C', 'Test: 30-day plan expired',         'listener', 'approved', 1),
 ('00000000-0000-4000-8000-000000000008', 'lifetime@test.swarkatha',      '$2a$10$c2gpYlk2z5F41dzbXav8COti7mwrfjnXgiCFDTHI8EFz0bQUbVB/C', 'Test: Lifetime',                    'listener', 'approved', 2),
 ('00000000-0000-4000-8000-000000000009', 'upcoming-180@test.swarkatha',  '$2a$10$c2gpYlk2z5F41dzbXav8COti7mwrfjnXgiCFDTHI8EFz0bQUbVB/C', 'Test: 180-day plan starts in 10 d', 'listener', 'approved', 1),
 ('00000000-0000-4000-8000-000000000010', 'device-full@test.swarkatha',   '$2a$10$c2gpYlk2z5F41dzbXav8COti7mwrfjnXgiCFDTHI8EFz0bQUbVB/C', 'Test: limit 1, slot already used',  'listener', 'approved', 1),
 ('00000000-0000-4000-8000-000000000011', 'device-mixed@test.swarkatha',  '$2a$10$c2gpYlk2z5F41dzbXav8COti7mwrfjnXgiCFDTHI8EFz0bQUbVB/C', 'Test: limit 3, 3 devices',          'listener', 'approved', 3),
 ('00000000-0000-4000-8000-000000000012', 'device-over@test.swarkatha',   '$2a$10$c2gpYlk2z5F41dzbXav8COti7mwrfjnXgiCFDTHI8EFz0bQUbVB/C', 'Test: limit lowered below devices', 'listener', 'approved', 1),
 ('00000000-0000-4000-8000-000000000013', 'device-free@test.swarkatha',   '$2a$10$c2gpYlk2z5F41dzbXav8COti7mwrfjnXgiCFDTHI8EFz0bQUbVB/C', 'Test: limit 2, no devices yet',     'listener', 'approved', 2);

-- ---- subscriptions (dates are relative to today in India time, so this stays fresh) ----
with d as (select (now() at time zone 'Asia/Kolkata')::date as today)
insert into subscriptions (user_id, is_lifetime, start_date, end_date, plan, is_trial, expires_at, note)
select * from (
  -- running trial, ~47 h left
  select '00000000-0000-4000-8000-000000000002'::uuid, false, d.today - 1, ((now() + interval '47 hours') at time zone 'Asia/Kolkata')::date, 'trial', true, now() + interval '47 hours', null::text from d
  union all -- trial with ~3 h left (shows "3 hours left")
  select '00000000-0000-4000-8000-000000000003'::uuid, false, d.today - 3, ((now() + interval '3 hours') at time zone 'Asia/Kolkata')::date, 'trial', true, now() + interval '3 hours', null from d
  union all -- trial already over
  select '00000000-0000-4000-8000-000000000004'::uuid, false, d.today - 4, ((now() - interval '6 hours') at time zone 'Asia/Kolkata')::date, 'trial', true, now() - interval '6 hours', null from d
  union all -- 90 days, 20 used
  select '00000000-0000-4000-8000-000000000005'::uuid, false, d.today - 20, d.today + 70, '90', false, null::timestamptz, 'Paid by bank transfer (test)' from d
  union all -- 30 days, 3 left
  select '00000000-0000-4000-8000-000000000006'::uuid, false, d.today - 27, d.today + 3, '30', false, null, null from d
  union all -- 30 days, ended 15 days ago
  select '00000000-0000-4000-8000-000000000007'::uuid, false, d.today - 45, d.today - 15, '30', false, null, null from d
  union all -- lifetime
  select '00000000-0000-4000-8000-000000000008'::uuid, true, d.today - 100, null::date, 'lifetime', false, null, null from d
  union all -- not started yet
  select '00000000-0000-4000-8000-000000000009'::uuid, false, d.today + 10, d.today + 190, '180', false, null, null from d
  union all -- the three device-test users all have a working plan
  select '00000000-0000-4000-8000-000000000010'::uuid, false, d.today - 5, d.today + 360, '365', false, null, null from d
  union all
  select '00000000-0000-4000-8000-000000000011'::uuid, false, d.today - 5, d.today + 360, '365', false, null, null from d
  union all
  select '00000000-0000-4000-8000-000000000012'::uuid, false, d.today - 5, d.today + 360, '365', false, null, null from d
  union all
  select '00000000-0000-4000-8000-000000000013'::uuid, false, d.today - 5, d.today + 360, '365', false, null, null from d
) t(user_id, is_lifetime, start_date, end_date, plan, is_trial, expires_at, note);

-- ---- trial ledger: these emails have already used their one trial ----
insert into trial_claims (email_normalized, email, user_id, first_source, last_source) values
 ('trial-running@test.swarkatha', 'trial-running@test.swarkatha', '00000000-0000-4000-8000-000000000002', 'self',  'self'),
 ('trial-ending@test.swarkatha',  'trial-ending@test.swarkatha',  '00000000-0000-4000-8000-000000000003', 'admin', 'admin'),
 ('trial-expired@test.swarkatha', 'trial-expired@test.swarkatha', '00000000-0000-4000-8000-000000000004', 'self',  'self'),
 ('active-90@test.swarkatha',     'active-90@test.swarkatha',     '00000000-0000-4000-8000-000000000005', 'self',  'self');
-- none@ / expiring@ / ... have NOT used a trial. (none@ is the one to try "Start free trial" on.)

-- ---- history shown in the admin app ----
insert into subscription_history (user_id, action, is_lifetime, start_date, end_date, detail) values
 ('00000000-0000-4000-8000-000000000002', 'trial_claimed', false, current_date - 1, current_date + 2, 'Claimed by the listener'),
 ('00000000-0000-4000-8000-000000000003', 'trial_granted', false, current_date - 3, current_date,     'Granted by an admin'),
 ('00000000-0000-4000-8000-000000000004', 'trial_claimed', false, current_date - 4, current_date - 1, 'Claimed by the listener'),
 ('00000000-0000-4000-8000-000000000005', 'trial_claimed', false, current_date - 25, current_date - 22, 'Claimed by the listener'),
 ('00000000-0000-4000-8000-000000000005', 'upgraded',      false, current_date - 20, current_date + 70, '90-day plan from the trial'),
 ('00000000-0000-4000-8000-000000000007', 'assigned',      false, current_date - 45, current_date - 15, '30-day plan'),
 ('00000000-0000-4000-8000-000000000008', 'assigned',      true,  current_date - 100, null,             'Lifetime plan');

-- ---- devices (fake hashes: they only exist so the admin app has something to show) ----
-- device-full: limit 1 and the one slot is taken, so a REAL phone signing in as this
-- user is refused with "Device limit reached". That is the way to test the limit message.
insert into user_devices (user_id, label, manufacturer, model, os_version, app_version, android_id_hashes, drm_hashes, first_seen_at, last_active_at, login_count) values
 ('00000000-0000-4000-8000-000000000010', 'Samsung SM-A546E', 'Samsung', 'SM-A546E', 'Android 14 (API 34)', '1.0.0', array['test-aid-full-1'], array['test-drm-full-1'], now() - interval '20 days', now() - interval '2 days', 12);

-- device-mixed: one normal phone, one Dual-App copy, one blocked phone.
insert into user_devices (user_id, status, label, manufacturer, model, os_version, app_version, android_id_hashes, drm_hashes, secondary_env, clone_reasons, first_seen_at, last_active_at, login_count, blocked_at) values
 ('00000000-0000-4000-8000-000000000011', 'active',  'Xiaomi Redmi Note 12', 'Xiaomi',  'Redmi Note 12', 'Android 13 (API 33)', '1.0.0', array['test-aid-mixed-1'], array['test-drm-mixed-1'], false, '{}',                 now() - interval '30 days', now() - interval '1 hour',  40, null),
 ('00000000-0000-4000-8000-000000000011', 'active',  'Samsung SM-M135F',     'Samsung', 'SM-M135F',      'Android 13 (API 33)', '1.0.0', array['test-aid-mixed-2'], array['test-drm-mixed-2'], true,  array['secondary_user'], now() - interval '10 days', now() - interval '3 days',  5,  null),
 ('00000000-0000-4000-8000-000000000011', 'blocked', 'OnePlus CPH2423',      'OnePlus', 'CPH2423',       'Android 14 (API 34)', '1.0.0', array['test-aid-mixed-3'], array['test-drm-mixed-3'], false, '{}',                 now() - interval '8 days',  now() - interval '6 days',  3,  now() - interval '5 days');

-- device-over: limit is 1 but three phones are registered (as if the admin lowered it).
-- The OLDEST phone keeps working; the two newer ones are refused.
insert into user_devices (user_id, label, manufacturer, model, os_version, app_version, android_id_hashes, drm_hashes, first_seen_at, last_active_at, login_count) values
 ('00000000-0000-4000-8000-000000000012', 'Samsung Galaxy S21', 'Samsung', 'SM-G991B', 'Android 14 (API 34)', '1.0.0', array['test-aid-over-1'], array['test-drm-over-1'], now() - interval '40 days', now() - interval '1 day',  30),
 ('00000000-0000-4000-8000-000000000012', 'Realme RMX3511',     'Realme',  'RMX3511',  'Android 13 (API 33)', '1.0.0', array['test-aid-over-2'], array['test-drm-over-2'], now() - interval '20 days', now() - interval '4 days', 9),
 ('00000000-0000-4000-8000-000000000012', 'Vivo V2250',         'Vivo',    'V2250',    'Android 13 (API 33)', '1.0.0', array['test-aid-over-3'], array['test-drm-over-3'], now() - interval '5 days',  now() - interval '5 days', 2);

-- ---- check: this should list 13 rows with the statuses described in each name ----
select u.email, s.plan, s.is_trial, s.end_date, s.expires_at, u.device_limit,
       (select count(*) from user_devices d where d.user_id = u.id and d.status = 'active') as devices_active
from app_users u left join subscriptions s on s.user_id = u.id
where u.email like '%@test.swarkatha'
order by u.email;
