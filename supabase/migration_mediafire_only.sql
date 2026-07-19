-- SwarKatha migration: drop Backblaze B2 support, MediaFire-only storage.
-- Run this in the Supabase SQL editor AFTER schema.sql and
-- migration_labels_albums.sql.
--
-- IMPORTANT: this deletes any existing Backblaze storage_accounts rows
-- and the media_items that point at them, since the app can no longer
-- read/stream from Backblaze once this ships. If you still have live
-- Backblaze-hosted media, re-upload it to a MediaFire account BEFORE
-- running this migration.

-- 1) Remove media_items that are still on Backblaze.
delete from media_items where storage_provider = 'backblaze';

-- 2) Remove Backblaze storage_accounts (favorites/play_progress cascade
--    only through media_items, already cleaned up above).
delete from storage_accounts where provider = 'backblaze';

-- 3) Re-point defaults and tighten the check constraints to MediaFire only.
alter table storage_accounts alter column provider set default 'mediafire';
alter table storage_accounts drop constraint if exists storage_accounts_provider_check;
alter table storage_accounts add constraint storage_accounts_provider_check
  check (provider in ('mediafire'));

alter table media_items alter column storage_provider set default 'mediafire';
alter table media_items drop constraint if exists media_items_storage_provider_check;
alter table media_items add constraint media_items_storage_provider_check
  check (storage_provider in ('mediafire'));

-- 4) Drop columns that only ever applied to Backblaze (pay-as-you-go
--    accountId + manual byte allocation — MediaFire reports real
--    used/free bytes directly via last_known_free_bytes).
alter table storage_accounts drop column if exists external_account_id;
alter table storage_accounts drop column if exists allocated_bytes;
