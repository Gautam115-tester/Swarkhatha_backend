# SwarKatha Backend (Phase 1)

Node.js/Express API that sits between the Flutter app and its media storage. It exists
specifically so that:
- Storage credentials (Drime access tokens) never touch the app or the device.
- The app can ask "which account has room for this file?" without holding any storage
  credentials itself.
- Streaming/download URLs are resolved on demand, short-lived, and never expose the
  underlying Drime credentials to the client.

Storage runs on **Drime Cloud only**: connect as many Drime accounts as you need, tag
each one for `music`, `audio_story`, or `both`, and the backend routes uploads,
streaming and downloads to the right one.

> Drime's file-bytes endpoint always requires that account's access token on every
> request — there's no MediaFire-style "direct, credential-free" link type. So instead
> of handing the app a raw Drime URL, `GET /api/storage/stream-url/:id` and
> `/download-url/:id` mint a short-lived (default 15 min), single-purpose signed URL
> pointing back at **this backend's own** `/api/storage/stream/:id` and `/file/:id`
> routes. Those routes fetch the bytes from Drime server-side (keeping the account's
> token private) and pipe them straight through to the app, forwarding `Range` so
> playback can seek/scrub normally.

## Endpoints

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | `/api/auth/signup` | public | listener signup |
| POST | `/api/auth/login` | public | login, returns app JWT |
| POST | `/api/storage/accounts` | admin | connect a Drime account |
| GET | `/api/storage/accounts` | admin | list all storage accounts + live free space |
| PATCH | `/api/storage/accounts/:id` | admin | rename/re-tag an account |
| POST | `/api/storage/upload` | admin | uploads a file; auto-picks or uses `accountId` |
| GET | `/api/storage/stream-url/:mediaItemId` | any logged-in user | resolves a short-lived playback URL |
| GET | `/api/storage/download-url/:mediaItemId` | any logged-in user | resolves a short-lived offline-download URL |
| GET | `/api/storage/stream/:mediaItemId` | signed URL or logged-in user | proxies the actual playback bytes from Drime |
| GET | `/api/storage/file/:mediaItemId` | signed URL or logged-in user | proxies the actual download bytes from Drime (forces `Content-Disposition: attachment`) |
| GET/POST/DELETE | `/api/media` | mixed | catalog CRUD, favorites, resume progress |

## Adding a storage account (admin flow)

Drime has no app-wide credentials to register up front — each account is connected
purely by generating a personal access token from that Drime account's own dashboard:

1. Log in to [Drime Cloud](https://app.drime.cloud).
2. Go to **Account Settings → Developers → Create a token**.
3. Name it, click **Create**, and copy the token.

Then call `POST /api/storage/accounts` once per Drime account:

```bash
curl -X POST https://<service>.onrender.com/api/storage/accounts \
  -H "Authorization: Bearer <admin JWT>" -H "Content-Type: application/json" \
  -d '{
    "accessToken": "<the personal access token from step 3>",
    "workspaceId": 0,
    "purpose": "both",
    "label": "Drime - main"
  }'
```

`workspaceId` defaults to `0` (personal workspace); pass a specific workspace id if
you want uploads to land in a shared Drime workspace instead. `folderId` is optional
and scopes every upload from this account into one Drime folder.

Credentials are encrypted (AES-256-GCM) before being stored in `storage_accounts`; the
app never sees them.

## Space-aware upload

`POST /api/storage/upload` (multipart form: `file`, `mediaType`, optional `accountId`,
optional `folder`):
- If `accountId` is given, it uploads straight to that account (after checking its
  `purpose` matches `mediaType`).
- If omitted, it auto-picks the best-fitting account by most recently known free
  space (Drime reports real used/available bytes on every `GET /user/space-usage`
  call).
- Returns `507 Insufficient Storage` if nothing matches.
- Files under 5MB go through Drime's simple presigned-upload flow; anything at or
  above that automatically uses Drime's multipart upload flow (10MB chunks) instead —
  audio-story episodes in particular routinely exceed the 5MB simple-upload
  threshold.
- The response includes `storageFileId` (Drime's file entry id, used to delete the
  file later) and `storageHash` (used to stream/download the file's bytes) — **both**
  need to be passed to `POST /api/media` when registering the catalog entry.

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

Run the schema in `supabase/schema.sql` via the Supabase SQL editor, then
`supabase/migration_labels_albums.sql`. If you're upgrading an existing deployment
that had MediaFire storage accounts connected, also run
`supabase/migration_mediafire_only.sql` (if you hadn't already) and then
`supabase/migration_drime_only.sql` last.

Optional env vars (see `.env.example`):
- `STORAGE_REFRESH_INTERVAL_MS` (default `8000`) — how often the backend polls each
  Drime account in the background for the live storage dashboard
  (`GET /api/storage/accounts/live`, an SSE stream consumed by the admin app's Storage
  screen).
- `STREAM_TOKEN_TTL_SECONDS` (default `900`) — how long the signed stream/download
  URLs returned by `stream-url`/`download-url` stay valid before the app needs to ask
  for a fresh one.
- `DRIME_API_BASE` — override the Drime API base URL (rarely needed).

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
