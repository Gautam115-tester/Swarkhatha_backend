-- SwarKatha migration: dedicated story_series table for audio stories.
-- Run this in the Supabase SQL editor AFTER migration_labels_albums.sql.
-- Safe to run once; uses IF NOT EXISTS / ON CONFLICT so re-running is harmless.
--
-- WHY THIS EXISTS
-- Music already gets a real `albums` table (see migration_labels_albums.sql):
-- every track is find-or-created against a proper row with its own id,
-- cover image, and a track_count that the backend keeps in sync. Audio
-- stories never got the equivalent — episodes were only ever grouped by
-- matching the free-text `media_items.story_title` column, with no id,
-- no dedicated cover image, and episode counts computed on the fly by
-- scanning every audio_story row on every request (see the old
-- GET /api/media/stories). This migration brings audio stories up to
-- parity with albums.

-- ============ STORY SERIES (auto-created from audio_story metadata) ============
-- One row per distinct story title — the audio-story equivalent of `albums`.
create table if not exists story_series (
  id uuid primary key default uuid_generate_v4(),
  title text not null,
  narrator text,
  cover_image_url text,
  episode_count int not null default 0,
  created_at timestamptz default now(),
  unique (title)
);

-- Link media_items to a real story_series row, same pattern as album_id.
-- story_title/album_or_series stay as-is (still read by the older
-- listener app), story_series_id is the new source of truth going forward.
alter table media_items add column if not exists story_series_id uuid references story_series(id);

create index if not exists idx_media_story_series on media_items(story_series_id);

alter table story_series enable row level security;
create policy "story_series readable by all authenticated" on story_series
  for select using (true);

-- ============ BACKFILL ============
-- Create a story_series row for every distinct story_title that already
-- exists in media_items, and link existing episodes to it, so running
-- this migration on a database with existing uploads doesn't orphan them.
insert into story_series (title, episode_count)
select story_title, count(*)
from media_items
where type = 'audio_story' and story_title is not null and story_title <> ''
group by story_title
on conflict (title) do nothing;

update media_items m
set story_series_id = s.id
from story_series s
where m.type = 'audio_story' and m.story_title = s.title and m.story_series_id is null;

-- Note: writes to story_series happen only via the backend service role
-- (see the findOrCreateStorySeries() helper in routes/media.js) — never
-- exposed to either Flutter app directly, same as albums.
