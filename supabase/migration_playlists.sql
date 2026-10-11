-- SwarKatha migration: User Playlists.
-- Run this in the Supabase SQL editor after schema.sql and the other
-- migration_*.sql files.
--
-- Playlists live in the database (not on the phone), tied to the listener's
-- account -- so uninstalling and reinstalling the app, or signing in on a
-- new phone, brings every playlist back.
--
-- Rules enforced here (not just in the app, so they can't be bypassed):
--   * a listener can own at most 10 playlists
--   * a playlist is either a 'music' playlist or an 'audio_story' playlist,
--     and only holds items of that type (checked by the API routes)

-- ============ PLAYLISTS ============
create table playlists (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references app_users(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  type text not null check (type in ('music','audio_story')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index idx_playlists_user on playlists(user_id, created_at);

-- Two playlists with the same name (ignoring case) would be impossible to
-- tell apart in the "Add to playlist" sheet.
create unique index uq_playlists_user_name on playlists(user_id, lower(btrim(name)));

-- ============ PLAYLIST ITEMS ============
-- ON DELETE CASCADE on media_item_id: when an admin deletes a track/episode
-- it silently drops out of every playlist instead of blocking the delete.
create table playlist_items (
  playlist_id uuid not null references playlists(id) on delete cascade,
  media_item_id uuid not null references media_items(id) on delete cascade,
  position int not null default 0,
  added_at timestamptz default now(),
  primary key (playlist_id, media_item_id)
);
create index idx_playlist_items_order on playlist_items(playlist_id, position);

-- ============ 10-PLAYLIST LIMIT (race-safe) ============
-- The API also checks this first to return a friendly message; the trigger
-- is the real guarantee, e.g. if two requests arrive at the same moment.
create or replace function enforce_playlist_limit() returns trigger as $$
begin
  -- Serialise concurrent inserts for the same user.
  perform pg_advisory_xact_lock(hashtext(new.user_id::text));
  if (select count(*) from playlists where user_id = new.user_id) >= 10 then
    raise exception 'PLAYLIST_LIMIT_REACHED' using errcode = 'P0001';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger trg_playlist_limit
  before insert on playlists
  for each row execute function enforce_playlist_limit();

-- Only the backend (service role) touches these tables; with RLS on and no
-- policies, the public anon key can read/write nothing.
alter table playlists enable row level security;
alter table playlist_items enable row level security;
