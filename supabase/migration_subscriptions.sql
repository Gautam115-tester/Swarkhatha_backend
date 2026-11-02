-- SwarKatha migration: manual subscription management.
-- Run this in the Supabase SQL editor AFTER schema.sql and the other
-- migration_*.sql files (it needs app_users and uuid_generate_v4()).
-- Safe to re-run: everything is guarded with IF NOT EXISTS / OR REPLACE.
--
-- This is a MANUAL system: an admin assigns, extends, renews or edits a
-- listener's subscription from the admin app. There are no payments,
-- billing, gateways or auto-renewals anywhere in this schema.
--
-- What is (and deliberately is not) stored:
--   * subscriptions        ONE row per listener = their CURRENT term.
--   * subscription_history append-only audit log of every admin action.
--   * user_notifications   the listener's in-app inbox (expiry reminders +
--                          "your subscription was updated" notes).
-- The status (active / expiring soon / expired / lifetime) and the
-- remaining days are NEVER stored. They are derived from start_date /
-- end_date and today's date every time they are read (lib/subscription.js),
-- so they can't go stale and the admin app and listener app can't disagree.

-- ============ CURRENT SUBSCRIPTION ============
create table if not exists subscriptions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null unique references app_users(id) on delete cascade,
  is_lifetime boolean not null default false,
  -- Plain calendar dates (no time of day). A 30-day plan starting 1 Jan ends
  -- on 31 Jan (end = start + duration) and stays valid through the end of
  -- that day; it shows as Expired from the next day.
  start_date date not null,
  end_date date,                      -- NULL exactly when is_lifetime
  note text,                          -- optional admin-only remark
  created_by uuid references app_users(id) on delete set null,
  updated_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subscriptions_term_chk check (
    (is_lifetime and end_date is null)
    or (not is_lifetime and end_date is not null and end_date >= start_date)
  )
);

-- The daily expiry job and the admin "expiring / expired" filters range-scan
-- on end_date; lifetime rows have none, so keep them out of the index.
create index if not exists idx_subscriptions_end_date
  on subscriptions(end_date) where not is_lifetime;

-- ============ HISTORY (audit log) ============
create table if not exists subscription_history (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references app_users(id) on delete cascade,
  action text not null check (action in ('assigned','renewed','extended','modified','removed')),
  is_lifetime boolean not null default false,
  start_date date,
  end_date date,
  detail text,                        -- e.g. "+30 days", "plan 90 days"
  performed_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_subscription_history_user
  on subscription_history(user_id, created_at desc);

-- ============ LISTENER NOTIFICATIONS (in-app inbox) ============
create table if not exists user_notifications (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references app_users(id) on delete cascade,
  kind text not null check (kind in
    ('expiry_7','expiry_3','expiry_1','expired','subscription_updated')),
  title text not null,
  body text not null,
  -- Makes the expiry job idempotent: "<user>:<kind>:<end_date>" can only be
  -- inserted once, however many times the job (or the listener opening the
  -- app) runs. Extending/renewing changes end_date, so the NEW term gets a
  -- fresh set of reminders. NULL for notes that may repeat (updated).
  dedupe_key text unique,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_user_notifications_user
  on user_notifications(user_id, created_at desc);
create index if not exists idx_user_notifications_unread
  on user_notifications(user_id) where read_at is null;

-- ============ LIST VIEW FOR THE ADMIN APP ============
-- Every listener with their subscription (if any) flattened into one row, so
-- the admin list can filter / search / sort / page with plain PostgREST
-- filters. Only the backend (service role) ever reads this.
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
  s.updated_at    as subscription_updated_at
from app_users u
left join subscriptions s on s.user_id = u.id
where u.role = 'listener';

-- Service-role-only, like the rest of the backend tables: with RLS on and no
-- policies, the public anon key can't read or write any of this.
alter table subscriptions enable row level security;
alter table subscription_history enable row level security;
alter table user_notifications enable row level security;
