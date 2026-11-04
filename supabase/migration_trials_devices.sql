-- SwarKatha migration: free trial, device registry + limits, admin activity log.
-- Run in the Supabase SQL editor AFTER migration_subscriptions.sql.
-- Safe to re-run: everything is guarded (IF NOT EXISTS / OR REPLACE / drop-then-add).
--
-- Still NO payments anywhere. An admin assigns every paid plan and Lifetime by
-- hand; the only self-service action is the one-time 3-day trial.
--
-- What this adds
--   subscriptions.plan / is_trial / expires_at   the 3-day trial as a 6th plan
--   trial_claims        PERMANENT one-row-per-email ledger. Never cascades away
--                       when a user is deleted, so an email can never re-claim.
--   user_devices        registered physical devices (hashed ids only)
--   app_users.device_limit   1..4 per user, admin-controlled
--   admin_activity_log  every admin action, who/what/when
--   sk_register_device()  ATOMIC device registration (limit + dedupe)
--   sk_check_device()     is this device still allowed? (blocked/removed/over limit)
--   sk_grant_trial()      ATOMIC trial claim/grant (eligibility ledger + term + history)
--
-- Atomicity: the two write functions take a per-user advisory lock, so two
-- phones logging in at the same instant, or two trial claims racing, serialise
-- instead of both slipping through a read-then-write gap.

-- ============ SUBSCRIPTIONS: plan + trial columns ============
alter table subscriptions add column if not exists plan text;
alter table subscriptions add column if not exists is_trial boolean not null default false;
-- Trials expire at an exact instant (claim time + 72h), not at the end of a
-- calendar day like paid plans. NULL for every non-trial row.
alter table subscriptions add column if not exists expires_at timestamptz;

update subscriptions set plan = case
    when is_lifetime then 'lifetime'
    when (end_date - start_date) in (30, 90, 180, 365) then (end_date - start_date)::text
    else 'custom'
  end
where plan is null;

alter table subscriptions alter column plan set default 'custom';
alter table subscriptions alter column plan set not null;

alter table subscriptions drop constraint if exists subscriptions_plan_chk;
alter table subscriptions add constraint subscriptions_plan_chk
  check (plan in ('trial', '30', '90', '180', '365', 'lifetime', 'custom'));

alter table subscriptions drop constraint if exists subscriptions_trial_chk;
alter table subscriptions add constraint subscriptions_trial_chk check (
  (is_trial and plan = 'trial' and not is_lifetime and expires_at is not null)
  or (not is_trial and plan <> 'trial' and expires_at is null)
);

-- ============ HISTORY + NOTIFICATION KINDS ============
alter table subscription_history drop constraint if exists subscription_history_action_check;
alter table subscription_history add constraint subscription_history_action_check check (action in (
  'assigned', 'renewed', 'extended', 'modified', 'removed',
  'upgraded', 'downgraded',
  'trial_claimed', 'trial_granted', 'trial_revoked'
));

alter table user_notifications drop constraint if exists user_notifications_kind_check;
alter table user_notifications add constraint user_notifications_kind_check check (kind in (
  'expiry_7', 'expiry_3', 'expiry_1', 'expired', 'subscription_updated', 'trial_expired'
));

-- ============ DEVICE LIMIT ============
-- Default 1 for everyone (including existing listeners); the admin raises it
-- to 2, 3 or 4 per user from the dashboard.
alter table app_users add column if not exists device_limit smallint not null default 1;
alter table app_users drop constraint if exists app_users_device_limit_chk;
alter table app_users add constraint app_users_device_limit_chk check (device_limit between 1 and 4);

-- ============ TRIAL LEDGER (permanent) ============
-- One row per CANONICAL email, ever. email_normalized is the primary key, so
-- "has this email had a trial?" is a unique-constraint question the database
-- answers atomically -- two simultaneous claims cannot both insert.
-- Deliberately NOT cascaded from app_users: deleting the account (or the user
-- reinstalling, clearing data, switching device) must not reset eligibility.
create table if not exists trial_claims (
  email_normalized text primary key,
  email text not null,                          -- as typed the first time
  user_id uuid references app_users(id) on delete set null,
  first_claimed_at timestamptz not null default now(),
  first_source text not null check (first_source in ('self', 'admin')),
  first_granted_by uuid references app_users(id) on delete set null,
  last_source text not null check (last_source in ('self', 'admin')),
  last_granted_at timestamptz not null default now(),
  times_granted int not null default 1,         -- >1 only via an explicit admin override
  device_keys text[] not null default '{}'      -- hashed ids of the device(s) used (optional device check)
);
create index if not exists idx_trial_claims_device_keys on trial_claims using gin (device_keys);
create index if not exists idx_trial_claims_user on trial_claims(user_id);

-- ============ DEVICES ============
-- Only keyed hashes of device identifiers are stored (HMAC with a server
-- secret), never raw Android IDs / DRM ids.
create table if not exists user_devices (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references app_users(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'blocked')),
  label text,
  platform text not null default 'android',
  manufacturer text,
  model text,
  os_version text,
  app_version text,
  -- Identity signals. A physical device can legitimately show several values
  -- over time (a Dual App / second user profile has its own ANDROID_ID), so
  -- these are alias lists that grow as the same device is recognised again.
  android_id_hashes text[] not null default '{}',
  drm_hashes text[] not null default '{}',
  hw_signature text,
  install_ids text[] not null default '{}',
  -- True while this device has ONLY ever been seen from a secondary Android
  -- user / dual-app / cloned environment (see sk_register_device).
  secondary_env boolean not null default false,
  clone_reasons text[] not null default '{}',
  first_seen_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  login_count int not null default 1,
  blocked_at timestamptz,
  blocked_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_user_devices_user on user_devices(user_id, status);
create index if not exists idx_user_devices_aid on user_devices using gin (android_id_hashes);
create index if not exists idx_user_devices_drm on user_devices using gin (drm_hashes);

-- ============ ADMIN ACTIVITY LOG ============
create table if not exists admin_activity_log (
  id uuid primary key default uuid_generate_v4(),
  admin_id uuid references app_users(id) on delete set null,
  admin_email text,                              -- kept even if the admin account is later deleted
  action text not null,                          -- e.g. 'subscription.assign', 'device.block'
  target_user_id uuid references app_users(id) on delete set null,
  target_email text,
  details jsonb not null default '{}'::jsonb,
  ip text,
  created_at timestamptz not null default now()
);
create index if not exists idx_admin_activity_created on admin_activity_log(created_at desc);
create index if not exists idx_admin_activity_target on admin_activity_log(target_user_id, created_at desc);

-- ============ LIST VIEW (adds plan / trial / device columns at the END) ============
create or replace view user_subscription_overview as
select
  u.id            as user_id,
  u.email,
  u.display_name,
  u.status        as account_status,
  u.created_at    as joined_at,
  s.id            as subscription_id,
  s.is_lifetime,
  s.start_date,
  s.end_date,
  s.note,
  s.updated_at    as subscription_updated_at,
  s.plan,
  s.is_trial,
  s.expires_at,
  u.device_limit,
  (select count(*) from user_devices d where d.user_id = u.id and d.status = 'active')::int as device_count
from app_users u
left join subscriptions s on s.user_id = u.id
where u.role = 'listener';

-- ============ FUNCTIONS ============

-- Public-safe JSON for a device: never exposes the identifier hashes.
create or replace function sk_device_json(d user_devices) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'id', d.id,
    'status', d.status,
    'label', d.label,
    'platform', d.platform,
    'manufacturer', d.manufacturer,
    'model', d.model,
    'os_version', d.os_version,
    'app_version', d.app_version,
    'secondary_env', d.secondary_env,
    'clone_reasons', to_jsonb(d.clone_reasons),
    'first_seen_at', d.first_seen_at,
    'last_active_at', d.last_active_at,
    'login_count', d.login_count,
    'blocked_at', d.blocked_at
  )
$$;

-- Registers (or recognises) a device for a user, atomically.
--
-- p_dev (all hashes already keyed-hashed by the backend):
--   { android_id_hash, drm_hash, hw_signature, install_id, secondary_env,
--     clone_reasons[], platform, manufacturer, model, os_version, app_version, label }
--
-- Recognition (same physical device => same row, never a second slot):
--   1. DRM hash matches            (device-wide, shared by every Android user/profile)
--   2. ANDROID_ID hash matches     (survives uninstall / reinstall / clear data)
--   3. Hardware signature matches AND either side was seen from a secondary
--      user / dual-app / clone environment AND the DRM ids do not contradict
--      each other. This folds a Dual App (which gets a different ANDROID_ID)
--      back onto its original device. Without the "secondary" condition two
--      identical phones would be merged just for having the same model; without
--      the DRM condition a friend's identical phone running a Dual App would
--      be mistaken for the registered one.
--
-- Returns { result: 'registered' | 'existing' | 'limit_reached' | 'blocked' | 'no_user', ... }
create or replace function sk_register_device(p_user_id uuid, p_dev jsonb)
returns jsonb language plpgsql as $$
declare
  v_limit int;
  v_aid text := nullif(p_dev->>'android_id_hash', '');
  v_drm text := nullif(p_dev->>'drm_hash', '');
  v_hw text := nullif(p_dev->>'hw_signature', '');
  v_install text := nullif(p_dev->>'install_id', '');
  v_secondary boolean := coalesce((p_dev->>'secondary_env')::boolean, false);
  v_reasons text[] := array(select jsonb_array_elements_text(coalesce(p_dev->'clone_reasons', '[]'::jsonb)));
  v_dev user_devices;
  v_active int;
begin
  perform pg_advisory_xact_lock(hashtextextended('sk_devices:' || p_user_id::text, 0));

  select device_limit into v_limit from app_users where id = p_user_id;
  if not found then
    return jsonb_build_object('result', 'no_user');
  end if;

  select * into v_dev
    from user_devices
   where user_id = p_user_id
     and ( (v_drm is not null and v_drm = any(drm_hashes))
        or (v_aid is not null and v_aid = any(android_id_hashes))
        or (v_hw is not null and hw_signature = v_hw and (v_secondary or secondary_env)
            -- ...but NEVER when both sides report a DRM id and they differ: the DRM
            -- id is device-wide, so a different one means a different physical
            -- phone (e.g. a friend's identical model running a Dual App).
            and (v_drm is null or cardinality(drm_hashes) = 0)) )
   -- If the same physical device somehow matches both a blocked and an active
   -- row, the blocked one wins: blocking can't be dodged through an alias.
   order by (status = 'blocked') desc, last_active_at desc
   limit 1;

  if found then
    if v_dev.status = 'blocked' then
      return jsonb_build_object('result', 'blocked', 'device', sk_device_json(v_dev), 'limit', v_limit);
    end if;

    update user_devices set
      last_active_at = now(),
      updated_at = now(),
      login_count = login_count + 1,
      hw_signature = coalesce(hw_signature, v_hw),
      drm_hashes = case
        when v_drm is null or v_drm = any(drm_hashes) then drm_hashes
        when array_length(drm_hashes, 1) >= 10 then array_append(drm_hashes[2:array_length(drm_hashes, 1)], v_drm)
        else array_append(drm_hashes, v_drm) end,
      android_id_hashes = case
        when v_aid is null or v_aid = any(android_id_hashes) then android_id_hashes
        when array_length(android_id_hashes, 1) >= 10 then array_append(android_id_hashes[2:array_length(android_id_hashes, 1)], v_aid)
        else array_append(android_id_hashes, v_aid) end,
      install_ids = case
        when v_install is null or v_install = any(install_ids) then install_ids
        when array_length(install_ids, 1) >= 20 then array_append(install_ids[2:array_length(install_ids, 1)], v_install)
        else array_append(install_ids, v_install) end,
      -- Stays "secondary only" only while no primary-environment login has
      -- been seen for this device.
      secondary_env = (secondary_env and v_secondary),
      clone_reasons = (select coalesce(array_agg(distinct r), '{}') from unnest(clone_reasons || v_reasons) r),
      manufacturer = coalesce(nullif(p_dev->>'manufacturer', ''), manufacturer),
      model = coalesce(nullif(p_dev->>'model', ''), model),
      os_version = coalesce(nullif(p_dev->>'os_version', ''), os_version),
      app_version = coalesce(nullif(p_dev->>'app_version', ''), app_version),
      label = coalesce(nullif(p_dev->>'label', ''), label)
    where id = v_dev.id
    returning * into v_dev;

    select count(*) into v_active from user_devices where user_id = p_user_id and status = 'active';
    return jsonb_build_object('result', 'existing', 'device', sk_device_json(v_dev), 'limit', v_limit, 'active_count', v_active);
  end if;

  select count(*) into v_active from user_devices where user_id = p_user_id and status = 'active';
  if v_active >= v_limit then
    return jsonb_build_object(
      'result', 'limit_reached',
      'limit', v_limit,
      'active_count', v_active,
      'devices', coalesce((
        select jsonb_agg(sk_device_json(d) order by d.first_seen_at)
          from user_devices d where d.user_id = p_user_id and d.status = 'active'
      ), '[]'::jsonb)
    );
  end if;

  insert into user_devices (
    user_id, label, platform, manufacturer, model, os_version, app_version,
    android_id_hashes, drm_hashes, hw_signature, install_ids, secondary_env, clone_reasons
  ) values (
    p_user_id,
    nullif(p_dev->>'label', ''),
    coalesce(nullif(p_dev->>'platform', ''), 'android'),
    nullif(p_dev->>'manufacturer', ''),
    nullif(p_dev->>'model', ''),
    nullif(p_dev->>'os_version', ''),
    nullif(p_dev->>'app_version', ''),
    case when v_aid is null then '{}'::text[] else array[v_aid] end,
    case when v_drm is null then '{}'::text[] else array[v_drm] end,
    v_hw,
    case when v_install is null then '{}'::text[] else array[v_install] end,
    v_secondary,
    v_reasons
  ) returning * into v_dev;

  return jsonb_build_object('result', 'registered', 'device', sk_device_json(v_dev), 'limit', v_limit, 'active_count', v_active + 1);
end;
$$;

-- Is this device still allowed to use the account right now?
--   'ok' | 'missing' (removed / reset / never registered) | 'blocked' | 'over_limit'
-- 'over_limit' covers an admin LOWERING the limit below the number of devices
-- already registered: the oldest-registered devices up to the limit keep
-- working, the newer ones stop until the admin removes some or raises the limit.
create or replace function sk_check_device(p_user_id uuid, p_device_id uuid)
returns text language plpgsql stable as $$
declare
  v_status text;
  v_first timestamptz;
  v_limit int;
  v_rank int;
begin
  select status, first_seen_at into v_status, v_first
    from user_devices where id = p_device_id and user_id = p_user_id;
  if not found then return 'missing'; end if;
  if v_status = 'blocked' then return 'blocked'; end if;

  select device_limit into v_limit from app_users where id = p_user_id;
  select count(*) into v_rank
    from user_devices
   where user_id = p_user_id and status = 'active'
     and (first_seen_at, id) <= (v_first, p_device_id);
  if v_rank > coalesce(v_limit, 1) then return 'over_limit'; end if;
  return 'ok';
end;
$$;

-- Claims (self) or grants (admin) the 3-day trial, atomically:
-- eligibility ledger + subscription term + history entry in ONE transaction.
--
--   p_source        'self' | 'admin'
--   p_force         admin-only override of "this email already had a trial"
--   p_device_keys   hashed device ids (optional extra check, self-claims only)
--   p_today/p_end_date  calendar dates in the business time zone (computed by the backend)
--   p_hours         trial length in hours (72)
--
-- Returns { ok: true, subscription } or { ok: false, code } where code is
--   has_subscription | trial_active | trial_already_used | trial_device_used
create or replace function sk_grant_trial(
  p_user_id uuid,
  p_email text,
  p_email_norm text,
  p_source text,
  p_admin uuid,
  p_force boolean,
  p_device_keys text[],
  p_check_device boolean,
  p_today date,
  p_end_date date,
  p_hours int
) returns jsonb language plpgsql as $$
declare
  v_sub subscriptions;
  v_claim trial_claims;
  v_row subscriptions;
  v_inserted int;
  v_expires timestamptz;
  v_force boolean := coalesce(p_force, false);
  v_keys text[] := coalesce(p_device_keys, '{}');
begin
  if p_source not in ('self', 'admin') then
    raise exception 'invalid trial source: %', p_source;
  end if;
  if p_source <> 'admin' then v_force := false; end if;   -- only an admin may override

  perform pg_advisory_xact_lock(hashtextextended('sk_sub:' || p_user_id::text, 0));

  select * into v_sub from subscriptions where user_id = p_user_id for update;
  if found then
    if p_source = 'self' then
      return jsonb_build_object('ok', false, 'code', 'has_subscription');
    end if;
    -- Admin: never silently replace a live paid / lifetime / upcoming term
    -- with a trial. A running trial or an already-lapsed term is fine.
    if v_sub.is_trial then
      if v_sub.expires_at > now() then
        return jsonb_build_object('ok', false, 'code', 'trial_active');
      end if;
    elsif v_sub.is_lifetime or v_sub.start_date > p_today or v_sub.end_date >= p_today then
      return jsonb_build_object('ok', false, 'code', 'has_subscription');
    end if;
  end if;

  -- Optional: the same physical device may not farm trials across emails.
  if p_check_device and p_source = 'self' and coalesce(array_length(v_keys, 1), 0) > 0 then
    if exists (
      select 1 from trial_claims
       where device_keys && v_keys and email_normalized <> p_email_norm
    ) then
      return jsonb_build_object('ok', false, 'code', 'trial_device_used');
    end if;
  end if;

  -- THE eligibility check: a primary-key insert. Exactly one concurrent
  -- claimant can ever insert a given email.
  insert into trial_claims (email_normalized, email, user_id, first_source, first_granted_by, last_source, device_keys)
  values (p_email_norm, p_email, p_user_id, p_source, p_admin, p_source, v_keys)
  on conflict (email_normalized) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 0 then
    if not v_force then
      select * into v_claim from trial_claims where email_normalized = p_email_norm;
      return jsonb_build_object('ok', false, 'code', 'trial_already_used',
                                'first_claimed_at', v_claim.first_claimed_at);
    end if;
    update trial_claims set
      times_granted = times_granted + 1,
      last_granted_at = now(),
      last_source = p_source,
      user_id = coalesce(user_id, p_user_id),
      device_keys = (select coalesce(array_agg(distinct k), '{}') from unnest(device_keys || v_keys) k)
    where email_normalized = p_email_norm;
  end if;

  v_expires := now() + make_interval(hours => p_hours);

  insert into subscriptions (user_id, is_lifetime, start_date, end_date, plan, is_trial, expires_at, note, created_by, updated_by)
  values (p_user_id, false, p_today, p_end_date, 'trial', true, v_expires, null, p_admin, p_admin)
  on conflict (user_id) do update set
    is_lifetime = false,
    start_date = excluded.start_date,
    end_date = excluded.end_date,
    plan = 'trial',
    is_trial = true,
    expires_at = excluded.expires_at,
    note = null,
    updated_by = excluded.updated_by,
    updated_at = now()
  returning * into v_row;

  insert into subscription_history (user_id, action, is_lifetime, start_date, end_date, detail, performed_by)
  values (
    p_user_id,
    case when p_source = 'self' then 'trial_claimed' else 'trial_granted' end,
    false, p_today, p_end_date,
    case when p_source = 'self' then 'Claimed by the listener'
         when v_force then 'Granted by an admin (override of an earlier trial)'
         else 'Granted by an admin' end,
    p_admin
  );

  return jsonb_build_object('ok', true, 'subscription', to_jsonb(v_row));
end;
$$;

-- ============ ACCESS CONTROL ============
-- Service-role only, like every other table here: with RLS on and no policies
-- the public anon key can read/write none of it, and the functions are not
-- callable by anon / authenticated.
alter table trial_claims enable row level security;
alter table user_devices enable row level security;
alter table admin_activity_log enable row level security;

revoke all on function sk_register_device(uuid, jsonb) from public;
revoke all on function sk_check_device(uuid, uuid) from public;
revoke all on function sk_grant_trial(uuid, text, text, text, uuid, boolean, text[], boolean, date, date, int) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function sk_register_device(uuid, jsonb) to service_role;
    grant execute on function sk_check_device(uuid, uuid) to service_role;
    grant execute on function sk_grant_trial(uuid, text, text, text, uuid, boolean, text[], boolean, date, date, int) to service_role;
  end if;
end $$;
