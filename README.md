# SwarKatha Backend (Phase 1)

Node.js/Express API that sits between the Flutter app and its media storage. It exists
specifically so that:
- Storage credentials (Backblaze B2 application keys, MediaFire email/password) never
  touch the app or the device.
- The app can ask "which account has room for this file?" without holding any storage
  credentials itself.
- Streaming URLs are resolved on demand, short-lived where possible, and never expose
  the underlying credentials to the client.

Storage is provider-agnostic: you can connect any mix of **Backblaze B2** and
**MediaFire** accounts, tag each one for `music`, `audio_story`, or `both`, and the
backend routes uploads/streaming to the right one.

> **Backblaze B2** is the recommended default — cheap, reliable, direct download links
> work even on a free-tier key. **MediaFire** is supported too, but its
> `direct_download` (actually-playable) links require a **paid** MediaFire account; on
> a free MediaFire account you'll only get a view-page URL back.

## Endpoints

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | `/api/auth/signup` | public | listener signup |
| POST | `/api/auth/login` | public | login, returns app JWT |
| POST | `/api/storage/accounts` | admin | connect a Backblaze B2 or MediaFire account |
| GET | `/api/storage/accounts` | admin | list all storage accounts + live free space |
| PATCH | `/api/storage/accounts/:id` | admin | rename/re-tag an account, set a manual space cap |
| POST | `/api/storage/upload` | admin | uploads a file; auto-picks or uses `accountId`/`provider` |
| GET | `/api/storage/stream-url/:mediaItemId` | any logged-in user | resolves a playback URL |
| GET/POST/DELETE | `/api/media` | mixed | catalog CRUD, favorites, resume progress |

## Adding a storage account (admin flow)

Both providers here use direct credentials — call `POST /api/storage/accounts` once
per account:

**Backblaze B2**
```bash
curl -X POST https://<service>.onrender.com/api/storage/accounts \
  -H "Authorization: Bearer <admin JWT>" -H "Content-Type: application/json" \
  -d '{
    "provider": "backblaze",
    "keyId": "<applicationKeyId>",
    "applicationKey": "<applicationKey>",
    "bucketId": "<bucketId>",
    "bucketName": "<bucketName>",
    "purpose": "both",
    "label": "Backblaze - main"
  }'
```

**MediaFire**
```bash
curl -X POST https://<service>.onrender.com/api/storage/accounts \
  -H "Authorization: Bearer <admin JWT>" -H "Content-Type: application/json" \
  -d '{
    "provider": "mediafire",
    "email": "you@example.com",
    "password": "...",
    "appId": "<application id, from mediafire.com/developers>",
    "apiKey": "<api key, optional but recommended>",
    "purpose": "music",
    "label": "MediaFire - backup"
  }'
```

Credentials are encrypted (AES-256-GCM) before being stored in `storage_accounts`; the
app never sees them.

## Space-aware upload

`POST /api/storage/upload` (multipart form: `file`, `mediaType`, optional `accountId`,
optional `provider`, optional `folder`):
- If `accountId` is given, it uploads straight to that account (after checking its
  `purpose` matches `mediaType`).
- If omitted, it auto-picks the best-fitting account — optionally narrowed to one
  `provider` — by most recently known free space.
- Backblaze B2 has no fixed quota (pay-as-you-go); set `allocatedBytes` via
  `PATCH /api/storage/accounts/:id` if you want the auto-picker to respect a soft cap.
- Returns `507 Insufficient Storage` if nothing matches.

To let the admin **choose** rather than auto-pick, call `GET /api/storage/accounts`
first, show the list with free space, then pass the chosen `accountId` + `provider`
into `/upload`.

## Setup

```bash
npm install
cp .env.example .env   # fill in real values
```

Generate `TOKEN_ENC_KEY` (32-byte hex key for AES-256-GCM):
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Run the schema in `supabase/schema.sql` via the Supabase SQL editor.

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
