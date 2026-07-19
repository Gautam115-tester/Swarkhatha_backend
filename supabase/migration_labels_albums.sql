-- SwarKatha migration: content labels (dropdown) + auto-created albums
-- Run this in the Supabase SQL editor AFTER the base schema.sql.
-- Safe to run once; uses IF NOT EXISTS / ON CONFLICT so re-running is harmless.

-- ============ CONTENT LABELS (admin-managed dropdown source) ============
-- Replaces free-typed media_items.category with a controlled, app-editable list.
create table if not exists content_labels (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  applies_to text not null default 'both' check (applies_to in ('music', 'audio_story', 'both')),
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz default now(),
  unique (name, applies_to)
);

insert into content_labels (name, applies_to, sort_order) values
  ('Classical', 'music', 1),
  ('Bollywood', 'music', 2),
  ('Folk', 'music', 3),
  ('Devotional', 'music', 4),
  ('Instrumental', 'music', 5),
  ('Epic Legends', 'audio_story', 1),
  ('Historical Dramas', 'audio_story', 2),
  ('Mythology', 'audio_story', 3),
  ('Kids Stories', 'audio_story', 4),
  ('Mystery & Thriller', 'audio_story', 5)
on conflict (name, applies_to) do nothing;

-- ============ ALBUMS (auto-created from music metadata) ============
-- One row per distinct (name, artist) pair. The upload flow does a
-- find-or-create against this table instead of writing a bare string
-- onto every track, so repeated uploads of the same album collapse
-- into a single album entity rather than duplicating the string.
create table if not exists albums (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  artist text,
  cover_image_url text,
  track_count int not null default 0,
  created_at timestamptz default now(),
  unique (name, artist)
);

-- Link media_items to a real album row. album_or_series stays as-is
-- (still used directly for audio_story series grouping); album_id is
-- only populated for type = 'music'.
alter table media_items add column if not exists album_id uuid references albums(id);
alter table media_items add column if not exists content_label_id uuid references content_labels(id);

-- Episode-title composition fields for audio_story, so the raw parts
-- survive independently of the composed "StoryTitle_EpNumber_EpTitle"
-- string stored in title/storage filename.
alter table media_items add column if not exists story_title text;
alter table media_items add column if not exists episode_title text;

create index if not exists idx_media_album on media_items(album_id);
create index if not exists idx_media_content_label on media_items(content_label_id);
create index if not exists idx_media_story_title on media_items(story_title);

alter table content_labels enable row level security;
alter table albums enable row level security;

create policy "content_labels readable by all authenticated" on content_labels
  for select using (true);
create policy "albums readable by all authenticated" on albums
  for select using (true);

-- Note: writes to content_labels and albums happen only via the backend
-- service role (see routes/labels.js and the album find-or-create logic
-- in routes/media.js) — never exposed to either Flutter app directly.
