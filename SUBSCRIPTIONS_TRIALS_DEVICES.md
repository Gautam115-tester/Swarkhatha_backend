# Subscriptions, free trial and device limits

Admin-controlled access for SwarKatha. **There is no payment gateway, payment
API, checkout page or payment processing anywhere in this system.** An admin
assigns every paid plan and Lifetime by hand (by the listener's email); the
only self-service action is the one-time 3-day free trial.

The backend database is the single source of truth. The apps display what the
server says; the server decides.

---

## 1. Deploy / roll out (do these in order)

1. **Run the SQL.** Supabase SQL editor, after `migration_subscriptions.sql`:
   `supabase/migration_trials_devices.sql` (safe to re-run).
2. **Set env vars** (see `.env.example`). Nothing new is *required*; defaults
   are sensible. `DEVICE_HASH_SECRET` is optional (falls back to
   `TOKEN_ENC_KEY`) and must never change after devices exist.
3. **Ship the new listener app first**, because the backend now refuses
   listener logins that carry no device information. If old builds are still
   in use, deploy the backend with `DEVICE_ENFORCEMENT=off`, let people
   update, then remove that setting.
4. **Before turning on `SUBSCRIPTION_ENFORCEMENT` (default `on`)**, remember
   that every listener without a plan or running trial will be refused audio.
   They can start the free trial themselves; for everyone else, assign plans
   from the admin app first, or deploy with `SUBSCRIPTION_ENFORCEMENT=off`
   and flip it when ready.
5. Existing listeners get **device limit 1**. Raise it per user in the admin
   app. Sessions created before this release have no device binding; the app
   registers the phone silently on its next request (or refuses with a clear
   message if the limit is already used).

### Release signing (important for device recognition)
`ANDROID_ID` is scoped to the app's **signing key**. `android/app/build.gradle.kts`
currently signs release builds with the *debug* key. Switch to a fixed release
keystore **before** shipping this to users, and never change it afterwards:
a new key means a new `ANDROID_ID` for every phone. The DRM id and hardware
signature mitigate this but are not a substitute. (Play App Signing keeps the
upload and app-signing keys separate; the app-signing key is what counts.)

---

## 2. The six plans

| Plan | How it ends | Who gives it |
|---|---|---|
| 3-Day Free Trial | exactly 72 h after it starts (an instant, not a calendar day) | user (once per email) or admin |
| 30 / 90 / 180 / 365 Days | valid through the end of the last calendar day (`SUBSCRIPTION_TZ`, default Asia/Kolkata) | admin |
| Lifetime | never | admin |

Admin operations: assign, renew, extend, upgrade / downgrade (change plan),
modify dates, revoke, grant / revoke trial. History records `assigned`,
`renewed`, `extended`, `modified`, `upgraded`, `downgraded`, `removed`
(= revoked), `trial_claimed`, `trial_granted`, `trial_revoked`.
A trial cannot be extended; a plan change cannot switch to a trial; granting a
trial never replaces a live paid / lifetime / not-yet-started term.

## 3. One trial per email, forever

* `trial_claims` is a permanent ledger with the **canonical email** as its
  primary key, so eligibility is a unique-constraint question the database
  answers atomically. Two simultaneous claims: exactly one inserts.
* Canonical email: lower-cased, `+tag` removed, and for Gmail also dots removed
  and `googlemail.com` → `gmail.com`. `a.b+x@gmail.com` is `ab@gmail.com`.
* The ledger is **not** cascaded from `app_users`: deleting the account,
  logging out, reinstalling, clearing data or switching phones cannot reset it.
* A revoked or expired trial still counts as used.
* A listener can only self-claim while they have **no** subscription row.
* Admin may override with `force` (UI asks for confirmation; `times_granted`
  is incremented and the override is logged).
* Optional `TRIAL_BLOCK_REUSED_DEVICE=on` also stops one phone farming trials
  across *different* emails. Off by default (the stated rule is per email, and
  sign-up already needs admin approval).

## 4. Device identification: what it can and cannot do

The app collects (Android, no permissions, no restricted identifiers):

| Signal | Survives reinstall / clear data | Same across Dual App / 2nd user | Notes |
|---|---|---|---|
| `ANDROID_ID` | yes (same signing key) | **no** (per user) | changes on factory reset |
| Widevine DRM id | yes | **yes** (device-wide) | missing on some devices; bound to make+model |
| Hardware signature | yes | **yes** | same for identical models, so only used to fold a *detected clone* onto its original |
| Clone evidence | – | – | second Android user, work profile, cloner-container data path, uid mismatch |

The server hashes every identifier (HMAC) before storing it, then, atomically
and under a per-user lock, decides whether this is a known device:

1. DRM hash matches, or
2. any known `ANDROID_ID` hash matches, or
3. hardware signature matches, **and** one side was seen in a clone / secondary
   environment, **and** the two DRM ids do not contradict each other. Two
   identical phones (say two iQOO Neo 7) are *not* merged: without clone
   evidence a matching signature proves nothing, and if both report a DRM id
   and the ids differ they are different handsets, even when one runs inside a
   Dual App.

Otherwise it is a new device: registered if under the limit, refused
(`device_limit_reached`) if not. A clone that is recognised adds its own
`ANDROID_ID` as an alias so it matches directly next time.

**Limits you should know about**
* Everything is reported by the app. A rooted phone with a hooking framework,
  or a modified APK, can fake fresh identifiers on every login. Closing that
  needs hardware attestation (Play Integrity) which needs a Google Cloud
  project and is not included.
* A factory reset is a new device (admin can remove the old one).
* **Residual gap:** if a Dual App on a friend's phone of the *same model* cannot
  read a DRM id (some devices expose none), the server cannot tell it from the
  registered phone and folds it onto it. If sharing between identical models
  worries you, set `CLONE_POLICY=block_all`: any Dual App / second user / work
  profile is then refused outright. The cost is that people who legitimately use
  their phone's own Dual Apps are refused too.
* A user can never free a slot themselves (logging out does not), so swapping
  phones always needs an admin to remove the old device.
* Some cloner containers spoof everything; set `CLONE_POLICY=block_virtual` to
  refuse the ones that are detectable. The default only de-duplicates, so it
  never locks out someone using the OS's own Dual Apps.
* Android only. There is no iOS identity code.

### What happens to a device
* **Remove**: slot freed, device signed out, may re-register if a slot is free.
* **Block**: stays recorded (so a reinstall can't dodge it), signed out, cannot
  sign in; doesn't count toward the limit; unblock is refused if it would
  exceed the limit.
* **Reset**: removes every device (blocked ones stay blocked unless asked).
* **Lowering the limit** below the registered count disables the *newest*
  devices (`device_over_limit`); the oldest `limit` keep working.
* Effect is on the device's very next request.

## 5. Enforcement (server side)

* `deviceGate` (every listener router): valid token → registered, un-blocked,
  within-limit device, else 403 with a `code`: `device_not_registered`,
  `device_blocked`, `device_over_limit`. Admin tokens pass.
* `requireEntitlement` (`stream-url`, `download-url`, and the direct Bearer
  path of `stream` / `file`): 403 `subscription_required` with
  `reason` = `none | upcoming | expired | trial_expired`.
* Catalog browsing stays open to a registered device; audio does not.
* Media tokens already issued stay valid for their short TTL (default 15 min).
* The app also stops playback at the instant access ends, and bounds
  **downloaded** files offline: they play only while the cached verdict is
  entitled, not past `validUntil`, re-verified within `OFFLINE_GRACE_HOURS`
  (72), and the device clock has not been wound back past the last check.

Error codes the apps understand: `device_info_required`,
`device_limit_reached`, `device_blocked`, `device_over_limit`,
`device_not_registered`, `clone_blocked`, `subscription_required`,
`trial_already_used`, `trial_device_used`, `has_subscription`, `trial_active`.

## 6. API additions

Listener
* `POST /api/auth/login` body gains `device: { androidId, hardwareId, hardwareSignature, installId, manufacturer, model, osVersion, appVersion, userHandle, cloneReasons[], secondaryEnv }`; the token carries `did`.
* `POST /api/devices/register`, `GET /api/devices/me`, `POST /api/devices/heartbeat`
* `GET /api/subscriptions/me` now also returns `access`, `trial`, `devices`
* `POST /api/subscriptions/me/trial`

Admin
* `POST /api/subscriptions/:userId/trial` (`{force}`), `DELETE …/trial`
* `POST …/assign` accepts plan `"trial"`; `PATCH …/:userId {plan}` is an upgrade / downgrade
* list filter `status=trial`; rows include `plan`, `deviceLimit`, `deviceCount`
* `GET /api/admin/users/:userId/devices`
* `PATCH /api/admin/users/:userId/device-limit {limit: 1|2|3|4}`
* `DELETE …/devices/:deviceId`, `POST …/devices/:deviceId/block|unblock`, `POST …/devices/reset`
* `GET /api/admin/activity?q=&userId=&limit=&offset=`

Every admin mutation is written to `admin_activity_log` (who, what, whom, when, details).

## 7. Tests

* `npm test`: unit + route tests against an in-memory fake (fast, no setup).
* `SK_INTEGRATION=1 node --test test/integration/trials_devices.it.test.js`:
  37 tests through the real routes and real supabase-js against real Postgres
  (see `test/integration/README.md`). They cover atomicity under concurrency,
  clone handling, blocking, limits, trial eligibility, enforcement and the
  admin dashboard filters. Mutating the SQL (dropping the limit check, or
  making hardware matching greedy) makes the matching tests fail.
