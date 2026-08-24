-- SwarKatha migration: Follow/Subscribe, Ratings & Reviews, Listening Stats,
-- and Forgot Password. Run this in the Supabase SQL editor after schema.sql
-- and the other migration_*.sql files.

-- ============ STORY FOLLOWS ============
-- Audio stories aren't backed by their own "series" table -- the apps group
-- episodes purely by media_items.album_or_series text (see
-- AppState.seriesKeyFor in the listener app). Following works the same way:
-- series_key IS that exact album_or_series string, so new episodes uploaded
-- under the same series automatically count as "already followed" with no
-- extra linking step needed.
create table story_follows (
  user_id uuid references app_users(id),
  series_key text not null,
  series_title text not null,      -- display copy captured at follow time
  cover_image_url text,            -- captured at follow time, for a "Following" list with no extra joins
  created_at timestamptz default now(),
  primary key (user_id, series_key)
);
create index idx_story_follows_user on story_follows(user_id);

-- ============ RATINGS & REVIEWS ============
-- One rating (+ optional written review) per listener per series. Keyed the
-- same way as story_follows, for the same reason.
create table story_ratings (
  user_id uuid references app_users(id),
  series_key text not null,
  rating int not null check (rating between 1 and 5),
  review text,
  updated_at timestamptz default now(),
  primary key (user_id, series_key)
);
create index idx_story_ratings_series on story_ratings(series_key);

-- ============ LISTENING EVENTS (for "Year in Audio" stats) ============
-- Append-only: one row per fully-completed play-through, logged from the
-- listener app's PlaybackHandler._onTrackCompleted (fires for music and
-- audio stories alike). Unlike play_progress (which only ever holds the
-- *current* resume position and is audio-story only), this is a running log
-- used purely for aggregate stats, so a best-effort insert failure here is
-- deliberately never allowed to surface as a playback error.
-- Denormalizes type/category/artist_or_narrator at insert time so stats
-- aggregation still works correctly for items that get deleted later.
create table listening_events (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references app_users(id),
  media_item_id uuid references media_items(id),
  type text not null check (type in ('music','audio_story')),
  category text,
  artist_or_narrator text,
  duration_seconds int,
  played_at timestamptz default now()
);
create index idx_listening_events_user on listening_events(user_id, played_at desc);

-- ============ PASSWORD RESET TOKENS ============
-- Single-use, short-lived. We store a hash of the token (never the raw
-- value) so a leaked database row alone can't be used to reset an account --
-- same reasoning as password_hash on app_users itself.
create table password_reset_tokens (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references app_users(id),
  token_hash text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz default now()
);
create index idx_password_reset_user on password_reset_tokens(user_id);
create index idx_password_reset_hash on password_reset_tokens(token_hash);
