-- SwarKatha Database Schema (Supabase / Postgres)
-- Run this in Supabase SQL editor.

create extension if not exists "uuid-ossp";

-- ============ APP USERS (admin + listeners) ============
create table app_users (
  id uuid primary key default uuid_generate_v4(),
  email text unique not null,
  password_hash text not null,
  display_name text,
  role text not null default 'listener' check (role in ('admin','listener')),
  created_at timestamptz default now()
);

-- ============ STORAGE ACCOUNTS (admin-added Backblaze B2 / MediaFire pools) ============
-- credentials_enc holds a JSON blob (shape depends on provider) encrypted at
-- rest by the app layer (see lib/crypto.js) — never store plaintext creds.
--   backblaze -> { keyId, applicationKey, bucketId, bucketName }
--   mediafire -> { email, password, appId, apiKey, folderKey }
create table storage_accounts (
  id uuid primary key default uuid_generate_v4(),
  provider text not null check (provider in ('backblaze','mediafire')),
  label text not null,                     -- e.g. "Backblaze - swarkatha-media"
  purpose text not null default 'both' check (purpose in ('music','audio_story','both')),
  credentials_enc text not null,
  external_account_id text,                -- Backblaze accountId, if applicable
  allocated_bytes bigint,                  -- optional manual cap for Backblaze (pay-as-you-go, no built-in quota)
  is_active boolean default true,
  last_known_free_bytes bigint,
  last_checked_at timestamptz,
  created_at timestamptz default now()
);

-- ============ MEDIA (music tracks + audio story chapters) ============
create table media_items (
  id uuid primary key default uuid_generate_v4(),
  type text not null check (type in ('music','audio_story')),
  title text not null,
  artist_or_narrator text,
  album_or_series text,
  cover_image_url text,
  duration_seconds int,
  file_size_bytes bigint,
  storage_provider text not null check (storage_provider in ('backblaze','mediafire')),
  storage_account_id uuid references storage_accounts(id),
  storage_file_id text not null,           -- B2 fileId, or MediaFire quickkey
  storage_path text not null,              -- path/filename within that account
  category text,                            -- Classical/Bollywood/Folk... or Epic Legends/Historical Dramas...
  chapter_number int,                       -- only for audio_story, ordering within a series
  uploaded_by uuid references app_users(id),
  created_at timestamptz default now()
);

create index idx_media_type on media_items(type);
create index idx_media_category on media_items(category);

-- ============ PLAY PROGRESS (resume playback) ============
create table play_progress (
  user_id uuid references app_users(id),
  media_item_id uuid references media_items(id),
  position_seconds int default 0,
  updated_at timestamptz default now(),
  primary key (user_id, media_item_id)
);

-- ============ FAVORITES ============
create table favorites (
  user_id uuid references app_users(id),
  media_item_id uuid references media_items(id),
  created_at timestamptz default now(),
  primary key (user_id, media_item_id)
);

-- Row Level Security
alter table media_items enable row level security;
alter table play_progress enable row level security;
alter table favorites enable row level security;

-- Listeners can read all media; only backend service role writes media_items/storage_accounts
create policy "media readable by all authenticated" on media_items
  for select using (true);

create policy "progress owned by user" on play_progress
  for all using (auth.uid()::text = user_id::text);

create policy "favorites owned by user" on favorites
  for all using (auth.uid()::text = user_id::text);

-- Note: storage_accounts and app_users password_hash are only ever touched by the
-- backend using the Supabase SERVICE ROLE key — never exposed to the Flutter app directly.