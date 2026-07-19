-- SwarKatha migration: drop MediaFire support, Drime-only storage.
-- Run this in the Supabase SQL editor AFTER schema.sql,
-- migration_labels_albums.sql, migration_mediafire_only.sql, and
-- migration_live_bandwidth_tracking.sql (i.e. only on a project that
-- was previously running the MediaFire version of this backend — a
-- brand new project can just use the current schema.sql instead).
--
-- IMPORTANT: this deletes any existing MediaFire storage_accounts rows
-- and the media_items that point at them, since the app can no longer
-- read/stream from MediaFire once this ships. If you still have live
-- MediaFire-hosted media, re-upload it to a Drime account BEFORE
-- running this migration.

-- 1) Remove media_items that are still on MediaFire.
delete from media_items where storage_provider = 'mediafire';

-- 2) Remove MediaFire storage_accounts (favorites/play_progress cascade
--    only through media_items, already cleaned up above).
delete from storage_accounts where provider = 'mediafire';

-- 3) Re-point defaults and tighten the check constraints to Drime only.
alter table storage_accounts alter column provider set default 'drime';
alter table storage_accounts drop constraint if exists storage_accounts_provider_check;
alter table storage_accounts add constraint storage_accounts_provider_check
  check (provider in ('drime'));

alter table media_items alter column storage_provider set default 'drime';
alter table media_items drop constraint if exists media_items_storage_provider_check;
alter table media_items add constraint media_items_storage_provider_check
  check (storage_provider in ('drime'));

-- 4) Drop columns that only ever applied to MediaFire premium accounts
--    (Drime's GET /user/space-usage reports plain used/available bytes
--    for every account the same way, no separate bandwidth-pool or
--    premium-tier concept to track).
alter table storage_accounts drop column if exists is_premium;
alter table storage_accounts drop column if exists last_known_bandwidth_remaining_bytes;

-- 5) Drime's file-bytes endpoint is looked up by hash (not by the file
--    entry id used for delete/rename), so media_items needs a place to
--    keep it. Required for every row going forward — the delete in
--    step 1 already cleared out any pre-Drime rows that wouldn't have
--    one.
alter table media_items add column if not exists storage_hash text;
alter table media_items alter column storage_hash set not null;
