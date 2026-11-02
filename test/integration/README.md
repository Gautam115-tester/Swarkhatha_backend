# Integration tests (real Postgres)

`trials_devices.it.test.js` runs the real route modules and the real
`@supabase/supabase-js` client against a real database, because the atomic
SQL functions, unique constraints, advisory locks and PostgREST filters can't
be proven by the in-memory fake.

It is skipped unless `SK_INTEGRATION=1`.

## One-time setup (any Postgres 14+ and PostgREST 12)

1. A scratch database with the repo's schema:
   `supabase/schema.sql` (ignore the `auth` schema RLS error, it is
   Supabase-only), `migration_user_approval.sql`, `migration_subscriptions.sql`,
   `migration_trials_devices.sql`.
2. Roles PostgREST expects:
   ```sql
   create role authenticator login noinherit password 'pw';
   create role anon nologin;
   create role service_role nologin bypassrls;
   grant anon, service_role to authenticator;
   grant usage on schema public to anon, service_role;
   grant all on all tables in schema public to service_role;
   grant execute on all functions in schema public to service_role;
   ```
   (re-run `migration_trials_devices.sql` afterwards so its function grants apply)
3. PostgREST config: `db-schemas="public"`, `db-anon-role="anon"`,
   `jwt-secret="<32+ chars>"`, `server-port=3100`.
4. `node scripts/it-proxy.js`: supabase-js talks to `<url>/rest/v1/...`; this
   tiny proxy strips that prefix (default `:3200 -> :3100`).

## Run

```
SK_INTEGRATION=1 \
SUPABASE_URL=http://127.0.0.1:3200 \
PGRST_JWT_SECRET='<same 32+ chars>' \
node --test test/integration/trials_devices.it.test.js
```

`contract/` holds two helper scripts (`.txt` so `node --test` doesn't run
them): one dumps real API responses, the other parses them with both Flutter
apps' Dart models to check the JSON contract.
