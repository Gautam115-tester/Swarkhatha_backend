// Free edge proxy for SwarKatha AUDIO STREAMING/DOWNLOADS ONLY, sitting
// in front of the Render backend. Split out from the combined worker so
// audio traffic and image traffic each get their own free-tier request
// quota on Cloudflare (100,000 requests/day EACH, instead of sharing
// one pool).
//
// Fetches audio bytes directly from Drime and streams them to the
// listener, so the heavy traffic never touches Render's Hobby-plan
// bandwidth cap. The tiny JSON credential lookup this needs (see GET
// /api/storage/resolve-media/:id in routes/storage.js) is edge-cached
// here for RESOLVE_CACHE_TTL_SECONDS, so Render is only actually asked
// once per media item per TTL window — not once per play — see
// resolveMediaCached() below for exactly what that trusts and why.
//
// SETUP (do this once)
//   1. https://workers.cloudflare.com -> sign up (free, no card needed).
//   2. Create a Worker (e.g. "swarkatha-audio-cdn"), paste this file in.
//   3. Replace ORIGIN below with your real deployed Render backend URL.
//   4. In the Worker's Settings -> Variables and Secrets, add two
//      SECRETS (not plain variables — these must be encrypted):
//        JWT_SECRET       = the exact same value as Render's JWT_SECRET
//        INTERNAL_SECRET  = the exact same value as Render's
//                           WORKER_INTERNAL_SECRET
//      If you already have these set from the old combined worker, copy
//      the same values here — they don't need to be new/unique per
//      worker, they just need to match Render on both ends.
//   5. Deploy. You'll get a URL like:
//        https://swarkatha-audio-cdn.<your-subdomain>.workers.dev
//   6. On Render, set/update:
//        AUDIO_CDN_BASE_URL = https://swarkatha-audio-cdn.<your-subdomain>.workers.dev
//      New stream-url/download-url responses now point at this worker
//      automatically. If AUDIO_CDN_BASE_URL is ever unset, everything
//      falls back to proxying through Render, no code changes needed.
//   7. Once both this worker and image-cdn-worker.js are deployed and
//      their env vars are set on Render, the old combined worker (the
//      one that handled both cover + audio in one file) can be retired.
//
// LIMITS: 100,000 requests/day on the free plan, resetting at midnight
// UTC, no bandwidth/egress charge ever. Requests over the limit just
// error until reset — no surprise billing. Paid plan is $5/mo for 10M
// requests/month if you outgrow this.

const ORIGIN = 'https://swarkhatha-7nk1.onrender.com'; // <-- set this to your real Render URL

// How long a resolved (mediaItemId -> Drime credentials) lookup is
// trusted at the edge before it's re-fetched from Render. Deliberately
// matches accountCache.js's TTL on the Render side (5 min) — that file
// already documents why 5 min is an acceptable staleness window for this
// exact data (admin edits to a storage account are rare, and Render's
// own PATCH /accounts/:id invalidates its cache immediately on write
// anyway). This just extends the same accepted tradeoff to the edge
// instead of inventing a new one.
const RESOLVE_CACHE_TTL_SECONDS = 300;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (
      request.method === 'GET' &&
      (url.pathname.startsWith('/api/storage/stream/') || url.pathname.startsWith('/api/storage/file/'))
    ) {
      return handleAudio(request, url, env, ctx);
    }

    // This worker must only ever serve audio — everything else (auth,
    // uploads, admin routes, cover images) goes elsewhere.
    return new Response('Not found', { status: 404 });
  }
};

/* ------------------------------------------------------------------
 * AUDIO STREAMING/DOWNLOADS — the audio bytes themselves are still
 * never cached (each request carries a short-lived, single-use token
 * and Range headers vary per request), just proxied straight through
 * from Drime to the listener. The *credential lookup* that precedes
 * them (resolveMediaCached, below) is what's now cached.
 * ------------------------------------------------------------------ */
async function handleAudio(request, url, env, ctx) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api','storage','stream'|'file', mediaItemId]
  const kind = parts[2]; // 'stream' or 'file'
  const mediaItemId = parts[3];
  const token = url.searchParams.get('token');

  if (!mediaItemId || !token) {
    return new Response('Missing media id or token', { status: 401 });
  }

  let payload;
  try {
    payload = await verifyMediaToken(token, env.JWT_SECRET);
  } catch (e) {
    return new Response('Invalid or expired token', { status: 401 });
  }

  const expectedPurpose = kind === 'file' ? 'download' : 'stream';
  if (payload.purpose !== expectedPurpose || payload.mid !== mediaItemId) {
    return new Response('Token does not match this request', { status: 401 });
  }

  // Resolve this media item -> Drime credentials, via the edge cache
  // when possible instead of always asking Render. See
  // resolveMediaCached for exactly what is/isn't trusted here.
  let resolved;
  try {
    resolved = await resolveMediaCached(mediaItemId, env, ctx);
  } catch (e) {
    return new Response('Failed to resolve media from origin', { status: 502 });
  }

  const { accessToken, hash, fileName, drimeApiBase } = resolved;

  const drimeHeaders = { Authorization: `Bearer ${accessToken}` };
  const range = request.headers.get('Range');
  if (range) drimeHeaders.Range = range;

  const upstream = await fetch(`${drimeApiBase}/file-entries/download/${hash}`, { headers: drimeHeaders });
  if (!upstream.ok && upstream.status !== 206) {
    return new Response(`Drime returned ${upstream.status}`, { status: 502 });
  }

  const headers = new Headers();
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  // Force this even if Drime omitted it, so Android/ExoPlayer and iOS
  // AVPlayer start playback from the first small range instead of
  // waiting for the whole file.
  if (!headers.has('accept-ranges')) headers.set('Accept-Ranges', 'bytes');

  if (kind === 'file') {
    const safeName = String(fileName || 'download').replace(/"/g, '');
    headers.set('Content-Disposition', `attachment; filename="${safeName}"`);
  } else {
    headers.set('Content-Disposition', 'inline');
    headers.set('Cache-Control', 'no-store');
  }

  return new Response(upstream.body, { status: upstream.status, headers });
}

/* ------------------------------------------------------------------
 * Edge-cached (mediaItemId -> Drime credentials) lookup.
 *
 * Before this, every single play — from every listener, even repeat
 * plays of the same popular track seconds apart — cost Render one live
 * round trip here. That's the one part of a stream request that scales
 * with (active users x plays), not with catalog size, so it's the
 * actual bottleneck once Render itself is warm and audio bytes already
 * bypass Render entirely.
 *
 * Security properties this relies on, spelled out explicitly rather
 * than assumed:
 *  - The cache key is built ONLY from mediaItemId, and mediaItemId only
 *    reaches this function after handleAudio has already verified it
 *    against a signed, expiring JWT (payload.mid === mediaItemId). A
 *    request can't poison or probe an arbitrary cache entry with raw
 *    unauthenticated input — it has to hold a valid token for that
 *    exact media item first.
 *  - The cache key is a synthetic internal Request
 *    (https://internal-cache.swarkatha/...) that is never derived from,
 *    and never matches, any URL a real client can send. It only exists
 *    as a lookup key inside caches.default and is not reachable by any
 *    incoming fetch.
 *  - The cached JSON contains a live Drime access token — the same
 *    sensitivity as what Render's accountCache.js already holds
 *    in-memory for 5 minutes today. This does not introduce a new kind
 *    of exposure, it extends an already-accepted one to the edge, with
 *    the same TTL. It is stored in Cloudflare's private edge cache
 *    (caches.default), not a public/shared CDN cache, and this
 *    function's return value is used only internally to build the
 *    upstream Drime request below — it is never written into any
 *    Response returned to a client.
 *  - ctx.waitUntil lets the cache write happen after the response to
 *    the *first* (cache-miss) request has already started streaming,
 *    so warming the cache never adds latency to the request that
 *    triggers it.
 * ------------------------------------------------------------------ */
async function resolveMediaCached(mediaItemId, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(`https://internal-cache.swarkatha/resolve-media/${mediaItemId}`);

  const cached = await cache.match(cacheKey);
  if (cached) {
    return await cached.json();
  }

  const resolveResp = await fetch(`${ORIGIN.replace(/\/$/, '')}/api/storage/resolve-media/${mediaItemId}`, {
    headers: { 'X-Internal-Secret': env.INTERNAL_SECRET }
  });
  if (!resolveResp.ok) {
    throw new Error(`resolve-media returned ${resolveResp.status}`);
  }
  const resolved = await resolveResp.json();

  const toCache = new Response(JSON.stringify(resolved), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `private, max-age=${RESOLVE_CACHE_TTL_SECONDS}`
    }
  });
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(cache.put(cacheKey, toCache));
  } else {
    await cache.put(cacheKey, toCache);
  }

  return resolved;
}

/* ------------------------------------------------------------------
 * Minimal HS256 JWT verification using the Web Crypto API (no npm
 * dependency needed — Workers ship SubtleCrypto natively). Mirrors what
 * jsonwebtoken.verify() does on the Render side for the same tokens
 * (see middleware/auth.js signMediaToken/requireMediaAccess).
 * ------------------------------------------------------------------ */
async function verifyMediaToken(token, secret) {
  const [headerB64, payloadB64, sigB64] = token.split('.');
  if (!headerB64 || !payloadB64 || !sigB64) throw new Error('Malformed token');

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    base64UrlToBytes(sigB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );
  if (!valid) throw new Error('Invalid signature');

  const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payloadB64)));
  if (payload.exp && Date.now() / 1000 > payload.exp) throw new Error('Token expired');
  return payload;
}

function base64UrlToBytes(b64url) {
  const padded = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(b64url.length + ((4 - (b64url.length % 4)) % 4), '=');
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}