-- SwarKatha migration: automatic multi-label music classification.
-- Run in the Supabase SQL editor AFTER schema.sql, migration_labels_albums.sql and
-- migration_centralized_artwork.sql, then run supabase/seed_music_labels.sql.
--
-- Safe to re-run (IF NOT EXISTS / CREATE OR REPLACE). Purely additive: it creates
-- new tables and functions and does NOT alter, backfill or delete anything in
-- media_items, content_labels or albums. media_items.content_label_id / category
-- keep working exactly as before; the engine only ever fills them when they are empty.
-- To remove everything again: supabase/migration_music_classification_down.sql.
--
-- All tables are service-role only (RLS on, no policies), like lyrics_cache.

-- ============ CONTROLLED VOCABULARY ============
create table if not exists music_labels (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null,
  dimension   text not null check (dimension in
                ('genre','mood','characteristic','vocal','language','context','version')),
  parent_id   uuid references music_labels(id) on delete set null,   -- hierarchy, e.g. Bollywood -> Indian Film Music -> Indian Music
  description text,
  legacy_name text,            -- name of the matching content_labels row, when there is one
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (dimension, slug)
);
create index if not exists idx_music_labels_parent on music_labels(parent_id);

-- ============ LABELS ASSIGNED TO RECORDINGS (many-to-many) ============
create table if not exists music_track_labels (
  id          uuid primary key default gen_random_uuid(),
  music_id    uuid not null references media_items(id) on delete cascade,
  label_id    uuid not null references music_labels(id) on delete restrict,
  confidence  numeric(4,3) not null check (confidence >= 0 and confidence <= 1),  -- per label, never per song
  source      text not null,                      -- 'metadata_consensus' | 'audio_analysis' | 'title_parse' | ... | 'manual'
  status      text not null check (status in ('approved','provisional','needs_review','rejected')),
  is_manual   boolean not null default false,     -- a human decided: the engine must never touch this row
  evidence    jsonb not null default '{}'::jsonb,
  assigned_at timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (music_id, label_id)
);
create index if not exists idx_mtl_music on music_track_labels(music_id);
create index if not exists idx_mtl_label_status on music_track_labels(label_id, status);
create index if not exists idx_mtl_review on music_track_labels(status, updated_at desc)
  where status in ('provisional','needs_review');

-- ============ CLASSIFICATION JOBS (durable queue) ============
create table if not exists music_classification_jobs (
  id               uuid primary key default gen_random_uuid(),
  music_id         uuid not null references media_items(id) on delete cascade,
  status           text not null default 'pending' check (status in
                     ('pending','processing','completed','partially_completed','failed','needs_review','cancelled')),
  reason           text not null default 'upload' check (reason in ('upload','backfill','manual','reclassify','retry')),
  dimensions       text[],                        -- null = every dimension
  priority         int  not null default 0,       -- uploads outrank backfill
  attempts         int  not null default 0,
  max_attempts     int  not null default 5,
  error_message    text,
  result           jsonb,
  locked_by        text,
  locked_at        timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  started_at       timestamptz,
  completed_at     timestamptz,
  next_retry_at    timestamptz,
  dead_lettered_at timestamptz
);
-- At most ONE open job per track: this is what makes enqueueing idempotent and race-safe.
create unique index if not exists uq_mcj_open_job on music_classification_jobs(music_id)
  where status in ('pending','processing');
create index if not exists idx_mcj_claim on music_classification_jobs(priority desc, created_at)
  where status = 'pending';
create index if not exists idx_mcj_status on music_classification_jobs(status, updated_at desc);
create index if not exists idx_mcj_music on music_classification_jobs(music_id, created_at desc);

-- ============ PER-RECORDING CLASSIFICATION METADATA ============
create table if not exists music_classification_metadata (
  music_id                 uuid primary key references media_items(id) on delete cascade,
  spotify_track_id         text,
  musicbrainz_recording_id text,
  musicbrainz_work_id      text,
  isrc                     text,
  recording_fingerprint    text,                  -- reserved; fingerprinting is not implemented yet
  detected_language        text,
  version_type             text,                  -- slug of the main version label ('original', 'remix', ...)
  composition_key          text,                  -- identical for every version of the same song
  original_title           text,
  match_confidence         numeric(4,3),
  classification_version   int  not null default 0,
  overall_status           text not null default 'unclassified' check (overall_status in
                             ('unclassified','partial','complete','needs_review','failed')),
  dimension_status         jsonb not null default '{}'::jsonb,   -- {"genre":"approved","mood":"unknown",...}
  last_classified_at       timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index if not exists idx_mcm_status on music_classification_metadata(overall_status);
create index if not exists idx_mcm_composition on music_classification_metadata(composition_key);
create index if not exists idx_mcm_mbid on music_classification_metadata(musicbrainz_recording_id);

-- ============ PROVENANCE: what each provider said about a recording ============
create table if not exists music_classification_sources (
  id               uuid primary key default gen_random_uuid(),
  music_id         uuid not null references media_items(id) on delete cascade,
  provider         text not null,
  external_id      text,
  match_confidence numeric(4,3),
  scope            text,                          -- 'recording' | 'composition'
  evidence         jsonb not null default '{}'::jsonb,   -- normalised evidence only, never raw responses
  fetched_at       timestamptz not null default now(),
  unique (music_id, provider)
);

-- ============ SHARED EXTERNAL-METADATA CACHE ============
create table if not exists music_provider_cache (
  provider   text not null,
  cache_key  text not null,
  found      boolean not null default true,       -- false = cached "nothing there" (negative cache)
  payload    jsonb,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (provider, cache_key)
);
create index if not exists idx_mpc_expires on music_provider_cache(expires_at);

-- ============ PROVIDER HEALTH (daily counters) ============
create table if not exists music_provider_stats (
  provider      text not null,
  day           date not null default current_date,
  ok            int  not null default 0,
  failed        int  not null default 0,
  rate_limited  int  not null default 0,
  last_error    text,
  last_error_at timestamptz,
  primary key (provider, day)
);

-- ============ HISTORICAL BACKFILL STATE (resumable) ============
create table if not exists music_classification_backfill (
  id          uuid primary key default gen_random_uuid(),
  status      text not null check (status in ('running','paused','completed','cancelled')),
  dry_run     boolean not null default false,
  batch_size  int not null default 50,
  options     jsonb not null default '{}'::jsonb,
  cursor_id   uuid,                               -- keyset cursor over media_items.id
  stats       jsonb not null default '{"scanned":0,"enqueued":0,"would_enqueue":0,"batches":0}'::jsonb,
  started_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  finished_at timestamptz
);
-- Only one backfill may be active at a time.
create unique index if not exists uq_mcb_single_active on music_classification_backfill ((true))
  where status in ('running','paused');

alter table music_labels                  enable row level security;
alter table music_track_labels            enable row level security;
alter table music_classification_jobs     enable row level security;
alter table music_classification_metadata enable row level security;
alter table music_classification_sources  enable row level security;
alter table music_provider_cache          enable row level security;
alter table music_provider_stats          enable row level security;
alter table music_classification_backfill enable row level security;

-- ============ FUNCTIONS ============

-- Atomically claim up to p_limit due jobs. FOR UPDATE SKIP LOCKED means several
-- workers / instances can poll at once without ever taking the same job.
create or replace function classification_claim_jobs(p_limit int, p_worker text)
returns setof music_classification_jobs
language sql
as $$
  with picked as (
    select id from music_classification_jobs
    where status = 'pending' and (next_retry_at is null or next_retry_at <= now())
    order by priority desc, created_at
    limit greatest(p_limit, 0)
    for update skip locked
  )
  update music_classification_jobs j
     set status = 'processing', locked_by = p_worker, locked_at = now(),
         started_at = now(), attempts = j.attempts + 1, updated_at = now()
    from picked
   where j.id = picked.id
  returning j.*;
$$;

-- Jobs whose worker died mid-flight (restart, crash, deploy): put them back in the
-- queue, or dead-letter them once they have used all their attempts. Returns how many moved.
create or replace function classification_recover_stale(p_lock_seconds int)
returns int
language plpgsql
as $$
declare n int;
begin
  with stale as (
    update music_classification_jobs
       set status = case when attempts >= max_attempts then 'failed' else 'pending' end,
           dead_lettered_at = case when attempts >= max_attempts then now() else dead_lettered_at end,
           error_message = coalesce(error_message, 'worker lost the job (restart or crash)'),
           locked_by = null, locked_at = null, next_retry_at = now(), updated_at = now()
     where status = 'processing' and locked_at < now() - make_interval(secs => p_lock_seconds)
    returning 1)
  select count(*) into n from stale;
  return n;
end;
$$;

-- Keyset-paginated discovery of tracks that still need classification. Never loads
-- the library: the caller passes the last id it saw and gets the next p_limit.
-- A track is a candidate when it
--   * has no classification metadata yet (this includes tracks that only have a legacy content_label_id), or
--   * was classified by an older engine version than p_min_version, or
--   * was never attempted for one of the required dimensions and has no approved/provisional label there.
-- Tracks that already have an open job are skipped. Only type = 'music' is considered.
create or replace function classification_backfill_candidates(
  p_after uuid, p_limit int, p_required text[], p_min_version int default 0)
returns table (id uuid)
language sql
stable
as $$
  select m.id
    from media_items m
    left join music_classification_metadata cm on cm.music_id = m.id
   where m.type = 'music'
     and (p_after is null or m.id > p_after)
     and not exists (select 1 from music_classification_jobs j
                      where j.music_id = m.id and j.status in ('pending','processing'))
     and (
          cm.music_id is null
       or cm.classification_version < p_min_version
       or exists (
            select 1 from unnest(p_required) as d(dim)
             where not (cm.dimension_status ? d.dim)
               and not exists (
                     select 1 from music_track_labels tl
                       join music_labels l on l.id = tl.label_id
                      where tl.music_id = m.id and l.dimension = d.dim
                        and tl.status in ('approved','provisional')))
     )
   order by m.id
   limit greatest(p_limit, 0);
$$;

create or replace function classification_record_provider_call(p_provider text, p_outcome text, p_error text default null)
returns void
language sql
as $$
  insert into music_provider_stats as s (provider, day, ok, failed, rate_limited, last_error, last_error_at)
  values (p_provider, current_date,
          (p_outcome = 'ok')::int, (p_outcome = 'failed')::int, (p_outcome = 'rate_limited')::int,
          case when p_outcome <> 'ok' then left(p_error, 500) end,
          case when p_outcome <> 'ok' then now() end)
  on conflict (provider, day) do update set
    ok = s.ok + (p_outcome = 'ok')::int,
    failed = s.failed + (p_outcome = 'failed')::int,
    rate_limited = s.rate_limited + (p_outcome = 'rate_limited')::int,
    last_error = case when p_outcome <> 'ok' then left(p_error, 500) else s.last_error end,
    last_error_at = case when p_outcome <> 'ok' then now() else s.last_error_at end;
$$;

-- One round trip for the admin dashboard.
create or replace function classification_stats()
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'total_tracks',   (select count(*) from media_items where type = 'music'),
    'complete',       (select count(*) from music_classification_metadata cm join media_items m on m.id = cm.music_id
                        where m.type = 'music' and cm.overall_status = 'complete'),
    'partial',        (select count(*) from music_classification_metadata cm join media_items m on m.id = cm.music_id
                        where m.type = 'music' and cm.overall_status = 'partial'),
    'needs_review',   (select count(*) from music_classification_metadata cm join media_items m on m.id = cm.music_id
                        where m.type = 'music' and cm.overall_status = 'needs_review'),
    'failed',         (select count(*) from music_classification_metadata cm join media_items m on m.id = cm.music_id
                        where m.type = 'music' and cm.overall_status = 'failed'),
    'jobs', coalesce((select jsonb_object_agg(status, n) from
                        (select status, count(*) n from music_classification_jobs group by status) x), '{}'::jsonb),
    'avg_classification_seconds',
                      (select round(avg(extract(epoch from (completed_at - started_at)))::numeric, 2) from
                        (select started_at, completed_at from music_classification_jobs
                          where completed_at is not null and started_at is not null
                          order by completed_at desc limit 500) r),
    'oldest_pending_seconds',
                      (select round(extract(epoch from (now() - min(created_at)))::numeric) from music_classification_jobs
                        where status = 'pending'),
    'providers', coalesce((select jsonb_object_agg(provider, jsonb_build_object(
                        'ok', ok, 'failed', failed, 'rate_limited', rate_limited,
                        'last_error', last_error, 'last_error_at', last_error_at)) from
                        (select provider, sum(ok)::int ok, sum(failed)::int failed, sum(rate_limited)::int rate_limited,
                                (array_agg(last_error order by last_error_at desc nulls last))[1] last_error,
                                max(last_error_at) last_error_at
                           from music_provider_stats where day >= current_date - 6 group by provider) p), '{}'::jsonb)
  );
$$;
