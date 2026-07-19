-- SwarKatha migration: track per-account bandwidth + richer storage
-- stats so the admin dashboard can show live-ish MediaFire numbers
-- without hitting MediaFire on every page load.
-- Run this in the Supabase SQL editor AFTER migration_mediafire_only.sql.

alter table storage_accounts add column if not exists last_known_used_bytes bigint;
alter table storage_accounts add column if not exists last_known_total_bytes bigint;
alter table storage_accounts add column if not exists last_known_bandwidth_remaining_bytes bigint;
alter table storage_accounts add column if not exists is_premium boolean default false;

-- last_known_free_bytes and last_checked_at already exist from schema.sql.
