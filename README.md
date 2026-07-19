# SwarKatha Backend (Phase 1)

Node.js/Express API that sits between the Flutter app and its media storage. It exists
specifically so that:
- Storage credentials (MediaFire email/password) never touch the app or the device.
- The app can ask "which account has room for this file?" without holding any storage
  credentials itself.
- Streaming URLs are resolved on demand, short-lived where possible, and never expose
  the underlying credentials to the client.

Storage runs on **MediaFire only**: connect as many MediaFire accounts as you need,
tag each one for `music`, `audio_story`, or `both`, and the backend routes
uploads/streaming to the right one.

> MediaFire's `direct_download` (actually-playable/downloadable) link type works on
> **every** account, free included — it's not paid-gated. Free accounts share a
> **50 GB/day** bandwidth pool for it; once that's used up for the day, both
> `stream-url` and `download-url` will fail until the pool resets (a paid MediaFire
> account keeps working past that daily cap). MediaFire's other link type,
> `normal_download`, is just the ad-gated `mediafire.com/file/...` web page — not raw
> file bytes — so it can't back either streaming or an automated app download; both
> endpoints here rely on `direct_download` only.

## Endpoints

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | `/api/auth/signup` | public | listener signup |
| POST | `/api/auth/login` | public | login, returns app JWT |
| POST | `/api/storage/accounts` | admin | connect a MediaFire account |
| GET | `/api/storage/accounts` | admin | list all storage accounts + live free space |
| PATCH | `/api/storage/accounts/:id` | admin | rename/re-tag an account |
| POST | `/api/storage/upload` | admin | uploads a file; auto-picks or uses `accountId` |
| GET | `/api/storage/stream-url/:mediaItemId` | any logged-in user | resolves a playback URL |
| GET | `/api/storage/download-url/:mediaItemId` | any logged-in user | resolves an offline-download URL |
| GET/POST/DELETE | `/api/media` | mixed | catalog CRUD, favorites, resume progress |

## Adding a storage account (admin flow)

Call `POST /api/storage/accounts` once per MediaFire account:

```bash
curl -X POST https://<service>.onrender.com/api/storage/accounts \
  -H "Authorization: Bearer <admin JWT>" -H "Content-Type: application/json" \
  -d '{
    "email": "you@example.com",
    "password": "...",
    "appId": "<application id, from mediafire.com/developers>",
    "apiKey": "<api key, optional but recommended>",
    "purpose": "both",
    "label": "MediaFire - main"
  }'
```

Credentials are encrypted (AES-256-GCM) before being stored in `storage_accounts`; the
app never sees them.

## Space-aware upload

`POST /api/storage/upload` (multipart form: `file`, `mediaType`, optional `accountId`,
optional `folder`):
- If `accountId` is given, it uploads straight to that account (after checking its
  `purpose` matches `mediaType`).
- If omitted, it auto-picks the best-fitting account by most recently known free
  space (MediaFire reports real used/free bytes on every account list call).
- Returns `507 Insufficient Storage` if nothing matches.

To let the admin **choose** rather than auto-pick, call `GET /api/storage/accounts`
first, show the list with free space, then pass the chosen `accountId` into `/upload`.

## Setup

```bash
npm install
cp .env.example .env   # fill in real values
```

Generate `TOKEN_ENC_KEY` (32-byte hex key for AES-256-GCM):
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Run the schema in `supabase/schema.sql` via the Supabase SQL editor. If you're
upgrading an existing deployment that had Backblaze accounts connected, also run
`supabase/migration_mediafire_only.sql` after `migration_labels_albums.sql`, then
run `supabase/migration_live_bandwidth_tracking.sql` (adds the columns the
live storage/bandwidth dashboard needs).

Optional env var: `STORAGE_REFRESH_INTERVAL_MS` (default `8000`) — how often
the backend polls each MediaFire account in the background for the live
storage/bandwidth dashboard (`GET /api/storage/accounts/live`, an SSE stream
consumed by the admin app's Storage screen).

```bash
npm run dev   # local dev with nodemon
npm start     # production
```

See `DEPLOYMENT.md` for deploying this to Render alongside the storage account setup
steps.

## What's NOT in this phase yet
- The Flutter app itself (player UI, admin upload screen, equalizer wiring)
- Full top-level README tying frontend + backend together

These come next — say the word and I'll build the Flutter side, wiring your existing
`EqualizerManager.kt` / `MainActivity.kt` in for the music player's equalizer (and
correctly leaving it out of the audio story player).
