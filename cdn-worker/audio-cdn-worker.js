// Free edge proxy for SwarKatha AUDIO STREAMING/DOWNLOADS ONLY, sitting
// in front of the Render backend. Split out from the combined worker so
// audio traffic and image traffic each get their own free-tier request
// quota on Cloudflare (100,000 requests/day EACH, instead of sharing
// one pool).
//
// Fetches audio bytes directly from Drime and streams them to the
// listener, so the heavy traffic never touches Render's Hobby-plan
// bandwidth cap. Render is only asked for a tiny JSON credential lookup
// per request (see GET /api/storage/resolve-media/:id in
// routes/storage.js) — never for the audio bytes themselves.
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

export default {
  async fetch(request, url_, env) {
    const url = new URL(request.url);

    if (
      request.method === 'GET' &&
      (url.pathname.startsWith('/api/storage/stream/') || url.pathname.startsWith('/api/storage/file/'))
    ) {
      return handleAudio(request, url, env);
    }

    // This worker must only ever serve audio — everything else (auth,
    // uploads, admin routes, cover images) goes elsewhere.
    return new Response('Not found', { status: 404 });
  }
};

/* ------------------------------------------------------------------
 * AUDIO STREAMING/DOWNLOADS — never cached (each request carries a
 * short-lived, single-use token and Range headers vary per request),
 * just proxied straight through from Drime to the listener.
 * ------------------------------------------------------------------ */
async function handleAudio(request, url, env) {
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

  // Ask Render to resolve this media item -> Drime credentials. This is
  // the only part of an audio request that still touches Render, and
  // it's a few hundred bytes of JSON regardless of file size.
  let resolved;
  try {
    const resolveResp = await fetch(`${ORIGIN.replace(/\/$/, '')}/api/storage/resolve-media/${mediaItemId}`, {
      headers: { 'X-Internal-Secret': env.INTERNAL_SECRET }
    });
    if (!resolveResp.ok) {
      return new Response('Failed to resolve media from origin', { status: 502 });
    }
    resolved = await resolveResp.json();
  } catch (e) {
    return new Response('Origin unreachable', { status: 502 });
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
