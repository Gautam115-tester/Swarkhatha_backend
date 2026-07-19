# SwarKatha — Deployment Guide (Backend)

This covers getting the Phase-1 backend live: Supabase project, Backblaze B2 / MediaFire
storage accounts, and the Node backend deployed to Render. Do these in order — later
steps need values from earlier ones.

---

## 1. Create the Supabase project

1. Go to supabase.com → New Project. Pick a region close to your users, set a strong DB password.
2. Once created, open **SQL Editor** → New query → paste the contents of `supabase/schema.sql` → Run.
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

You don't need to pre-register anything with Render/OAuth here — both providers use
direct credentials that get sent once to `POST /api/storage/accounts` after the backend
is deployed (step 4 below). Gather the values now:

**Backblaze B2**
1. Go to backblaze.com → sign up → **B2 Cloud Storage** → create a bucket (private is
   fine — the backend mints short-lived download tokens per stream request).
2. **App Keys** → **Add a New Application Key** → scope it to that bucket → copy the
   `keyID` and `applicationKey` (the applicationKey is only shown once).
3. Note the bucket's `bucketId` and `bucketName` from the bucket list.

**MediaFire**
1. Sign up at mediafire.com. **A paid plan is needed if you want listeners to stream
   directly** — free accounts can still store files, but `stream-url` will only return
   a view-page link, not a playable one.
2. Go to mediafire.com/developers → register an application → copy the **Application
   ID** and **API Key**.

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
    "provider": "backblaze",
    "keyId": "<applicationKeyId>",
    "applicationKey": "<applicationKey>",
    "bucketId": "<bucketId>",
    "bucketName": "<bucketName>",
    "purpose": "both",
    "label": "Backblaze - main"
  }'
```
Then confirm it's live:
```bash
curl https://<your-service-name>.onrender.com/api/storage/accounts \
  -H "Authorization: Bearer <the JWT>"
```
should list that account with its live free space.

---

## 5. Repeat for additional accounts (either provider)

Just call `POST /api/storage/accounts` again with a different provider/credentials.
Each becomes its own row in `storage_accounts` — no code changes needed to add more
storage, and you can freely mix Backblaze and MediaFire accounts.

---

## Common issues

| Symptom | Likely cause |
|---|---|
| `401 Invalid or expired token` on every request | `JWT_SECRET` differs between when the token was issued and now (e.g. you changed it after deploy) — log in again |
| MediaFire `stream-url` returns a view-page link instead of a direct one | The connected MediaFire account is on a free plan — `direct_download` links require a paid MediaFire account |
| Free space always shows stale numbers | `/api/storage/accounts` refreshes on every call for MediaFire; Backblaze free space is based on your own `allocatedBytes` setting (via `PATCH /api/storage/accounts/:id`), since B2 has no built-in quota |
| Upload returns 507 | No connected account currently has enough free space for that file — add another account, raise `allocatedBytes`, or free up space in an existing one |
| Backblaze account setup fails immediately | Double-check `keyId`/`applicationKey` are from an **Application Key** (not the master key) scoped to the bucket, and `bucketId`/`bucketName` match exactly |

Next: the Flutter app itself, wired to these endpoints.
