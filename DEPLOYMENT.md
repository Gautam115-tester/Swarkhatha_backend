# SwarKatha — Deployment Guide (Backend)

This covers getting the Phase-1 backend live: Supabase project, Drime storage
accounts, and the Node backend deployed to Render. Do these in order — later steps
need values from earlier ones.

---

## 1. Create the Supabase project

1. Go to supabase.com → New Project. Pick a region close to your users, set a strong DB password.
2. Once created, open **SQL Editor** → New query → paste the contents of `supabase/schema.sql` → Run.
   Then run `supabase/migration_labels_albums.sql`. If you're upgrading a project that
   already had MediaFire storage accounts connected, also run
   `supabase/migration_mediafire_only.sql` and then `supabase/migration_drime_only.sql`
   last, in that order.
3. Go to **Project Settings → API**. Copy:
   - `Project URL` → this is `SUPABASE_URL`
   - `service_role` key (NOT `anon`) → this is `SUPABASE_SERVICE_ROLE_KEY`

   The service role key bypasses Row Level Security and must only ever live in your
   backend's environment variables — never ship it inside the Flutter app.

4. Seed your first admin user. Easiest way: SQL Editor →
   ```sql
   insert into app_users (email, password_hash, display_name, role)
   values ('you@example.com', '$2a$10$REPLACE_WITH_BCRYPT_HASH', 'Admin', 'admin');
   ```
   Generate the bcrypt hash locally first:
   ```bash
   node -e "console.log(require('bcryptjs').hashSync('yourPassword123', 10))"
   ```
   (run this from inside the backend folder after `npm install`, then paste the output
   into the SQL above).

---

## 2. Set up your storage accounts

You don't need to pre-register anything with Render/OAuth here — Drime uses a
per-account personal access token that gets sent once to `POST /api/storage/accounts`
after the backend is deployed (step 4 below). Gather the values now:

1. Sign up at [app.drime.cloud](https://app.drime.cloud). The free plan includes
   20GB of storage, and the API is free to use on every plan.
2. Go to **Account Settings → Developers → Create a token**, name it, and copy the
   token. Repeat this once per Drime account you want to pool for storage.

---

## 3. Deploy the backend to Render

1. Push the `swarkatha-backend` folder to a GitHub repo.
2. On render.com → New → Web Service → connect the repo.
3. Settings:
   - **Root directory**: `swarkatha-backend` (if the repo has other folders in it)
   - **Build command**: `npm install`
   - **Start command**: `npm start`
   - **Instance type**: Free tier is fine for development; note free instances sleep
     after inactivity, which will delay the first request after idle — upgrade to a
     paid instance before letting real users hit it.
4. Add environment variables (Render → Environment tab) — copy every key from
   `.env.example` and fill in real values:
   - `PORT` → Render sets this automatically, but `8080` as a fallback is fine
   - `BASE_URL` → `https://<your-service-name>.onrender.com`
   - `JWT_SECRET` → generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
   - `TOKEN_ENC_KEY` → generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` → from step 1
5. Deploy.

---

## 4. Verify it's working

```bash
curl https://<your-service-name>.onrender.com/health
# expect: {"ok":true,"service":"swarkatha-backend"}
```

Log in as the admin you seeded:
```bash
curl -X POST https://<your-service-name>.onrender.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"yourPassword123"}'
```
You should get back a JWT. Use it to connect your first storage account:
```bash
curl -X POST https://<your-service-name>.onrender.com/api/storage/accounts \
  -H "Authorization: Bearer <the JWT>" -H "Content-Type: application/json" \
  -d '{
    "accessToken": "<personal access token from app.drime.cloud/account-settings>",
    "workspaceId": 0,
    "purpose": "both",
    "label": "Drime - main"
  }'
```
Then confirm it's live:
```bash
curl https://<your-service-name>.onrender.com/api/storage/accounts \
  -H "Authorization: Bearer <the JWT>"
```
should list that account with its live free space.

---

## 5. Repeat for additional accounts

Just call `POST /api/storage/accounts` again with a different Drime account's access
token. Each becomes its own row in `storage_accounts` — no code changes needed to add
more storage capacity.

---

## Common issues

| Symptom | Likely cause |
|---|---|
| `401 Invalid or expired token` on every request | `JWT_SECRET` differs between when the token was issued and now (e.g. you changed it after deploy) — log in again |
| `stream-url` / `download-url` links stop working after ~15 minutes | Expected — they're short-lived signed URLs (`STREAM_TOKEN_TTL_SECONDS`); the app should re-request `stream-url`/`download-url` if playback needs to resume after a long pause |
| Free space always shows stale numbers | `/api/storage/accounts` refreshes live from Drime on every call, so this shouldn't happen — check the account's access token hasn't been revoked from the Drime dashboard |
| Upload returns 507 | No connected account currently has enough free space for that file — add another account or free up space in an existing one |
| Drime account setup fails immediately | Double-check the `accessToken` was copied in full and hasn't been revoked — tokens are managed under Account Settings → Developers on app.drime.cloud |
| `POST /api/media` returns "Missing required fields" | Make sure both `storageFileId` and `storageHash` from the `/api/storage/upload` response are passed through — Drime needs both (one to delete, one to stream) |

Next: the Flutter app itself, wired to these endpoints.
