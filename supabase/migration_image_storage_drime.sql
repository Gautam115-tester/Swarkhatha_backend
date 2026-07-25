-- SwarKatha migration: move cover images off Supabase Storage and onto a
-- dedicated Drime account, same as music/audio_story.
-- Run this in the Supabase SQL editor AFTER migration_labels_albums.sql
-- and migration_story_series.sql. Safe to run once; uses IF NOT EXISTS /
-- IF EXISTS everywhere so re-running is harmless.
--
-- WHY A SEPARATE 'image' PURPOSE (not 'both')
-- 'both' has always meant "music & audio_story" — the two audio types.
-- Cover images get their own purpose instead of folding into 'both' so
-- that the new public, unauthenticated GET /api/storage/cover/:accountId/:hash
-- route (see routes/storage.js) can safely trust "this account's purpose
-- is 'image' " as its entire authorization check. If images shared an
-- account with paid/gated audio, that public route would need to reason
-- about individual file hashes instead of just the account's purpose.
-- Practically: connect one (or more) Drime accounts from the admin app's
-- Storage screen with purpose "Cover images" before running
-- scripts/migrate-cover-images-to-drime.js (that script can also create
-- the account for you — see its --token flag).

-- 1) Allow 'image' as a storage_accounts purpose.
alter table storage_accounts drop constraint if exists storage_accounts_purpose_check;
alter table storage_accounts add constraint storage_accounts_purpose_check
  check (purpose in ('music', 'audio_story', 'both', 'image'));

-- 2) Give albums and story_series somewhere to remember exactly which
--    Drime account/file/hash their cover art lives at — same trio
--    media_items already keeps for audio (storage_account_id,
--    storage_file_id, storage_hash). Needed so a cover can later be
--    re-migrated, deleted, or looked up without re-parsing its URL.
alter table albums add column if not exists image_storage_account_id uuid references storage_accounts(id);
alter table albums add column if not exists image_storage_file_id text;
alter table albums add column if not exists image_storage_hash text;

alter table story_series add column if not exists image_storage_account_id uuid references storage_accounts(id);
alter table story_series add column if not exists image_storage_file_id text;
alter table story_series add column if not exists image_storage_hash text;

-- Note: media_items.cover_image_url keeps being a denormalized copy of
-- whatever its album/story_series currently has (see findOrCreateAlbum /
-- findOrCreateStorySeries in routes/media.js) — it doesn't need its own
-- image_storage_* columns, exactly as it didn't need them when covers
-- lived on Supabase Storage.
