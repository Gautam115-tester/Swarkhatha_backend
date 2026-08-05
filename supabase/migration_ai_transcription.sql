-- SwarKatha migration: AI transcription / karaoke-style lyrics for audio stories.
-- Run this in the Supabase SQL editor AFTER migration_story_series.sql.
-- Safe to run once; uses IF NOT EXISTS / ON CONFLICT so re-running is harmless.
--
-- WHY THIS EXISTS
-- Music already gets synced lyrics (third-party lookup by artist+title —
-- see lyrics_service.dart in the listener app). Audio stories have no
-- equivalent, because there's no third-party lyrics database for narrated
-- audio. This adds a first-party pipeline instead: a pooled Groq account
-- transcribes each episode's own audio (Whisper) into whatever language was
-- actually spoken, with LINE-level timestamps, then a Groq-hosted LLM
-- translates (or, for Hinglish, transliterates) those same lines — keeping
-- their original timestamps — into the other target languages. Every
-- language therefore stays in sync with playback using the one Whisper
-- pass's timing, without re-running speech recognition per language.
--
-- Each language's result is stored as its own small JSON file on Drime,
-- piggybacking the *existing* audio_story/both storage_accounts pool (see
-- routes/transcripts.js#pickStorageAccount) rather than needing a new one.

-- ============ GROQ ACCOUNTS (admin-added, pooled like storage_accounts) ============
-- credentials_enc holds a JSON blob encrypted at rest by the app layer
-- (see lib/crypto.js) — never store plaintext keys.
--   groq -> { apiKey }
create table if not exists groq_accounts (
  id uuid primary key default uuid_generate_v4(),
  provider text not null default 'groq' check (provider in ('groq')),
  label text not null,
  credentials_enc text not null,
  is_active boolean default true,
  last_used_at timestamptz,
  last_error text,                 -- most recent failure seen on this key, surfaced in the admin app (no automatic deactivation — admin decides)
  created_at timestamptz default now()
);

-- ============ TRANSCRIPTS (one row per media_item x language) ============
create table if not exists transcripts (
  id uuid primary key default uuid_generate_v4(),
  media_item_id uuid not null references media_items(id) on delete cascade,
  language text not null check (language in ('hi','en','mr','bn','hi-en')),
  status text not null default 'pending' check (status in ('pending','processing','done','failed')),
  source_language text,                     -- Whisper's detected language for this episode's original pass
  is_source boolean not null default false, -- true for whichever language row IS that original Whisper pass (no translation step)
  segment_count int,
  storage_account_id uuid references storage_accounts(id),
  storage_file_id text,
  storage_hash text,
  storage_path text,
  error_message text,
  generated_by_account_id uuid references groq_accounts(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (media_item_id, language)
);

create index if not exists idx_transcripts_media_item on transcripts(media_item_id);

alter table groq_accounts enable row level security;
alter table transcripts enable row level security;

-- Listeners only ever need to know whether a transcript is ready and fetch
-- its (small, non-sensitive) content — same "readable by all authenticated"
-- shape as media_items/story_series. Writes happen only via the backend
-- service role, same as everywhere else in this schema.
create policy "transcripts readable by all authenticated" on transcripts
  for select using (true);

-- Note: groq_accounts (and its credentials_enc) is only ever touched by the
-- backend using the Supabase SERVICE ROLE key — never exposed to either
-- Flutter app directly, same as storage_accounts.
