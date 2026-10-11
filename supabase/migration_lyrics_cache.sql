-- Durable, shared lyrics cache (optional but recommended).
-- The first listener of a song pays for the lookup; everyone after gets it
-- in ~50 ms. Service-role only: RLS on, no policies.
create table if not exists public.lyrics_cache (
  key        text primary key,          -- "artist||title", normalised
  title      text,
  artist     text,
  source     text,
  synced     boolean not null default false,
  payload    jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.lyrics_cache enable row level security;
