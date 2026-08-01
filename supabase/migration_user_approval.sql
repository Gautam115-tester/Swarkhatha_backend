-- SwarKatha migration: listener signup approval workflow
-- Run this in the Supabase SQL editor AFTER the base schema.sql.
-- Safe to run once; uses IF NOT EXISTS / a guarded ADD COLUMN so re-running is harmless.

-- Existing rows (admins seeded manually, any listeners created before this
-- migration) default to 'approved' so nobody who could already log in gets
-- locked out. Only NEW listener self-signups start life as 'pending' —
-- routes/auth.js sets that explicitly on insert.
alter table app_users
  add column if not exists status text not null default 'approved'
    check (status in ('pending', 'approved', 'rejected'));

create index if not exists idx_app_users_status on app_users(status);
