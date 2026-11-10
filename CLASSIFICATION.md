# Automatic music classification

One engine labels **every** music track, old and new, across seven independent dimensions
(genre, mood, characteristic, vocal, language, listening context, version). Each label carries its
own confidence, source, evidence and status. Nothing here replaces `media_items.category` /
`content_label_id`; those keep working exactly as before.

```
 upload (routes/media.js) ──┐                      ┌── MusicBrainz  (recording match, genres, work language, artist gender)
                            ├─► jobs table ─► worker ─► engine ──┼── Spotify      (match, ids, artist genres if still returned)
 backfill (batches of 50) ──┘   (Postgres)        │              ├── Last.fm      (community tags, weak)
 admin "reclassify" ────────┘                      │              ├── Groq LLM     (text only, weak)
                                                   │              └── audio analyzer (optional, you host it)
                                                   └─► music_track_labels / music_classification_metadata / _sources
```

## What it does, honestly

| Dimension | Evidence it can really use | Can it reach `approved` without audio analysis? |
|---|---|---|
| version | markers in title/album (`(Reprise)`, `- Unplugged`, `Remix`, `Female Version`…), provider title/disambiguation | **Yes** (explicit marker = 0.97) |
| vocal | `Female/Male/Instrumental Version` markers, MusicBrainz credited-artist gender, legacy "Instrumental" | Only for explicit markers; gender-of-artist is a hint (≤0.72) |
| language | script of cached lyrics/title (Tamil, Telugu, Malayalam, Kannada, Gujarati, Bengali, Punjabi are unambiguous), Hindi vs Marathi by function words, MusicBrainz work language, tags | Yes when lyrics are cached, or when two sources agree |
| genre | existing label, MusicBrainz genres, Last.fm tags, Spotify artist genres, film hint, LLM | Yes, with ≥2 agreeing independent sources |
| mood / characteristic / context | community tags, LLM recall, **audio analyzer** | Realistically only with an audio analyzer; otherwise they stay `provisional`/`needs_review` |

* **No audio model ships with this project.** `providers/audio.js` is an adapter to an analyzer *you*
  host (contract in the file header). Until you run one, mood/characteristics are recall- and tag-based
  only, and by design cannot be auto-approved from a single weak source.
* **Fingerprinting (AcoustID/Chromaprint) is not implemented.** `recording_fingerprint` is a reserved column.
  Composer/lyricist are not stored.
* Recordings are matched on normalised title + artist + duration (+ album, + version agreement) — never title
  alone. A provider record of the *original* is used for a *Reprise* only for composition-level facts
  (broad genre, language); mood/vocals/version are never borrowed across versions.
* Confidence is per label: noisy-OR over **independent** source groups (one voice per group, so five Last.fm
  tags are still one voice), minus a contradiction penalty for mutually exclusive labels (one language, one lead
  vocal, Original vs any other version). Thresholds are configurable (defaults 0.95 / 0.85 / 0.70 / 0.50).
* "Fully classified" = every dimension in `CLASSIFY_REQUIRED_DIMENSIONS` (default genre, language, vocal,
  version) has an approved label. Mood etc. are recorded when evidence suffices but do not block completion.
  Without MusicBrainz/Spotify/Last.fm keys or lyrics, expect many tracks to finish `partial` — that is the system
  refusing to guess, not a bug.

### Provider facts this was built against (verify before relying on them)

* **MusicBrainz**: free, 1 request/second, a descriptive `User-Agent` with a contact is mandatory — the provider
  is off until `MUSICBRAINZ_CONTACT` is set. Up to ~5 calls per uncached track (search, recording, work,
  ≤2 artists), all cached; plan on ~5–6 s/track for a cold first pass (≈15 h per 10,000 tracks). Artist/work lookups
  are shared across tracks, so it speeds up. Set `MUSICBRAINZ_LOOKUP_ARTISTS=off` to drop the artist calls.
* **Spotify** (Feb 2026 Development-Mode changes): search is capped at 10 results; batch artist lookups, audio features,
  audio analysis and recommendations are not used; artist `genres` is deprecated, so Spotify may contribute only a
  match + track id.
* **Last.fm**: tag counts are 0–100; tags under `LASTFM_MIN_TAG_COUNT` (20) are ignored.
* The integrations are covered by tests with HTTP doubles shaped like those APIs (plus a real local HTTP
  server for the audio adapter). **They have not been run against the live services** — no network access or credentials were
  available when this was written. Check `GET /api/classification/status` → `providers` after your first run.

## Install (once)

1. In the Supabase SQL editor run, in order: `supabase/migration_music_classification.sql`, then
   `supabase/seed_music_labels.sql`. Both are idempotent. Additive only; nothing existing is altered.
   Rollback: `supabase/migration_music_classification_down.sql` (drops only what the migration created).
2. Deploy the backend. The worker starts with the server (`CLASSIFICATION_WORKER_ENABLED=on` by default) and
   re-seeds the vocabulary if needed. New uploads are queued automatically from this moment.
3. Optional: set provider variables (`.env.example` → "Automatic music classification").
4. Existing library: run the backfill (below). Do a **dry run first**.

Render free tier: the instance sleeps, so the in-process worker only works while awake. Jobs are durable in Postgres.
To drain while asleep, set `CLASSIFICATION_CRON_SECRET` and have an external scheduler call
`POST /api/classification/cron/run` with header `x-cron-secret: …` every few minutes (each call works for ≤ 20 s).
Keep a **single** worker instance: the MusicBrainz limiter is per process.

## Commands

```bash
npm run classification -- seed-taxonomy
npm run classification -- worker                       # long-running worker (also drives a running backfill)
npm run classification -- run-once --seconds 60        # drain the queue for a minute, then exit

# historical backfill (resumable; state lives in the database)
npm run classification -- backfill start --dry-run     # count what would be queued, enqueue nothing
npm run classification -- backfill start --batch 50    # real run
npm run classification -- backfill status
npm run classification -- backfill pause
npm run classification -- backfill resume              # also after a restart: it continues from its cursor
npm run classification -- backfill cancel

npm run classification -- retry-failed
npm run classification -- reclassify <trackId> [<trackId> ...]
npm run classification -- reclassify --all             # whole library (a backfill with reclassify semantics)
npm run classification -- classify <trackId> --dry-run # run the engine now, print labels + evidence, write nothing
npm run classification -- status
npm run classification -- track <trackId>
```

The backfill only *enqueues*; a worker (the server's, or `… worker`) does the classifying. Running it with the
server up is enough. It never loads the library: keyset pagination, 1–100 ids per batch, no new batch while ≥
`CLASSIFICATION_BACKFILL_MAX_PENDING` (200) jobs wait. A track is a candidate if it has no classification
metadata (this includes legacy-labelled tracks), was classified by an older engine version than `--min-version`,
or was never attempted for a required dimension. Non-music content is excluded.

## API (admin JWT unless noted)

| | |
|---|---|
| `GET /api/classification/status` | tracks (total / fully / partially / needs review / failed / unclassified), jobs by state, avg classification time, oldest pending, provider ok/failed/rate-limited, backfill, worker |
| `GET /labels[?dimension=]` | vocabulary (any signed-in user) |
| `GET /tracks/:id/labels` | approved labels only (any signed-in user) |
| `GET /tracks/:id` | everything: labels with confidence/source/evidence, metadata, provider sources, recent jobs |
| `GET /review[?dimension=]` | provisional / needs-review labels waiting for a human |
| `POST /tracks/:id/labels` | `{labelId \| key, action: add \| remove \| approve \| reject, note?}` — manual override |
| `POST /tracks/:id/reclassify`, `POST /reclassify` | `{ids:[…]}` or `{all:true}` |
| `POST /backfill`, `GET /backfill`, `POST /backfill/pause\|resume\|cancel` | `{batchSize?, dryRun?, minVersion?, requiredDimensions?, limit?}` |
| `GET /jobs[?status=]`, `POST /jobs/retry-failed`, `POST /seed` | |
| `POST /cron/run` | shared-secret header; hidden (404) unless `CLASSIFICATION_CRON_SECRET` is set |

The admin app has a **More › Music Labels** screen on top of these endpoints (progress, "Needs review" list, all music,
per-track label editor). The CLI still works too.

### Admin editing: change only, nothing is created

| | |
|---|---|
| `POST /tracks/:id/labels/change` | `{fromLabelId, toLabelId, note?}`: swap a label for another of the **same kind** (genre→genre, language→language…). Both must exist in the fixed vocabulary; anything else is a 400/404. Both rows become manual, so the engine never reverts them. A new **genre** also moves the legacy `category` / `content_label_id` the listener app browses by, but only if that genre maps to an active music content label (the automatic engine itself still only fills an *empty* legacy label). |
| `GET /library[?attention=1&labelId=&limit=&offset=]` | music with its labels (titles only: no covers, no audio). `attention=1` = only tracks with labels waiting for review |
| `POST /api/labels` with `appliesTo: music \| both` | now **403**: music labels are automatic. Audio-story labels are unchanged |

Uploading music no longer asks for a label; the upload screens say so. The older Groq "backfill missing categories" button
now only covers audio stories while classification is on (otherwise it would fill music's legacy category first, with weaker
evidence, and the engine's "only fill an empty one" rule would then skip it).

### No Render bandwidth

Labelling only moves small JSON between the backend and MusicBrainz / Last.fm / Spotify / Groq (title, artist, album, year).
No audio is read, downloaded or streamed by the backend for it. The optional audio analyzer stays **off**; if you ever turn it on,
its link now points at `AUDIO_CDN_BASE_URL` (the Cloudflare worker, which streams straight from Drime) and is **refused** when that
variable is not set, so audio can never be pulled through Render by accident. The admin app polls `/status` every 8 s only while
labelling is actually running.

## Guarantees and how they are enforced

* **Uploads never wait.** `routes/media.js` inserts the row, responds, then calls `enqueueNewMusic()`, which only inserts
  one jobs row and never rejects. If that fails (even if the migration isn't applied) the upload is unaffected and the
  backfill finds the track later. Failed uploads never reach that line. Audio stories are unchanged (Groq categorizer).
  `CLASSIFICATION_ENABLED=off` restores the old behaviour for music too.
* **No duplicate jobs:** partial unique index `uq_mcj_open_job` (one pending/processing job per track).
* **Resumable / crash-safe:** claim via `FOR UPDATE SKIP LOCKED`; `locked_at` + `classification_recover_stale` re-queue
  jobs orphaned by a restart; the backfill cursor is persisted.
* **Retries:** exponential backoff with jitter (30 s base, ×2, capped 6 h), `max_attempts` 5, then dead-letter
  (`failed`, `dead_lettered_at`; `retry-failed` re-queues). An incomplete result caused by a provider outage is retried;
  a permanently unusable provider (bad credentials, not configured) is not.
* **Provider isolation:** per-provider timeout, rate limiter, circuit breaker; one provider failing never fails the job.
* **Manual labels are sacred:** rows with `is_manual = true` (add, approve, reject, remove) are never modified — every
  automatic update is conditional on `is_manual = false`, and a manual *remove* is stored as a rejected row so the engine
  won't re-add it. The engine never deletes any label.
* **Legacy label:** `category` / `content_label_id` are only ever filled when **both** are empty, and only from an
  *approved* genre that maps to an active music label.
* **Privacy:** only title/artist/album/year go to Groq; the audio adapter is off unless enabled **and** consented **and**
  pointed at a URL, and it receives a short-lived, single-track, stream-only signed link, never storage credentials.
  Only normalised evidence is stored, not raw API responses. Keys are read from env, never logged or returned.

Job states: `pending → processing → completed | partially_completed | needs_review | failed | cancelled`.
A partially classified track is never reported as complete (`music_classification_metadata.overall_status`).

## Tests

```bash
npm test                                        # everything (SQL integration tests skip without a database)
TEST_DATABASE_URL=postgres://user:pw@host/db npm run test:sql   # real Postgres: migration, SKIP LOCKED claims, backfill SQL
```
Use a scratch database for `TEST_DATABASE_URL`; the test works inside its own throw-away schema.

## Cost

No new paid dependency. The existing Groq pool is used for ≤ 1 small text call per track (cached 30 days). MusicBrainz,
Spotify (client credentials) and Last.fm have free tiers. A hosted audio analyzer would be a new cost/infrastructure
decision, which is why none is bundled.
