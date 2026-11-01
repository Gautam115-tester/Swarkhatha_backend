/**
 * Cloudflare Worker — background Drime disk-space check (cron trigger).
 *
 * Why: Render's free tier puts the backend to sleep after ~15 min without
 * traffic, and a sleeping server can't run its own timer. This Worker
 * pings POST /api/storage/accounts/background-check on a schedule; the
 * request wakes the backend, which refreshes every Drime account's usage
 * and stores it in Supabase (storage_accounts.last_known_*), so the admin
 * app opens to current numbers.
 *
 * Setup (separate Worker from the image/audio CDN ones):
 *   1. Render env:   STORAGE_CRON_SECRET = <long random string>
 *   2. Worker vars:  BACKEND_URL  = https://swarkhatha-7nk1.onrender.com
 *                    CRON_SECRET  = <same long random string>   (add as a Secret)
 *   3. Cron trigger: every 25 minutes  ->  "*\/25 * * * *"   (remove the backslash)
 *      (wrangler.toml:  [triggers]  crons = ["*\/25 * * * *"])
 *
 * A sleeping Render instance can take 30-60 s to answer, hence the long timeout.
 * The endpoint skips the Drime calls itself if its cache is under 10 min old.
 */
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  },
  // Visit the Worker URL to trigger a check by hand while testing.
  async fetch(request, env) {
    return new Response(JSON.stringify(await run(env)), { headers: { 'content-type': 'application/json' } });
  }
};

async function run(env) {
  try {
    const resp = await fetch(`${env.BACKEND_URL}/api/storage/accounts/background-check`, {
      method: 'POST',
      headers: { 'x-cron-secret': env.CRON_SECRET },
      signal: AbortSignal.timeout(90_000)
    });
    const body = await resp.text();
    console.log('background-check', resp.status, body);
    return { status: resp.status, body };
  } catch (e) {
    console.log('background-check failed', e.message);
    return { error: e.message };
  }
}
