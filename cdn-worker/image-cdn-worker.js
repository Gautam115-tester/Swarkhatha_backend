// Free edge proxy for SwarKatha COVER IMAGES ONLY, sitting in front of
// the Render backend. Split out from the combined worker so image
// traffic and audio traffic each get their own free-tier request quota
// on Cloudflare (100,000 requests/day EACH, instead of sharing one pool).
//
// Edge-cached at Cloudflare, served straight from cache on every request
// after the first. No secrets needed — this worker never touches JWTs
// or Drime credentials, it just proxies + caches whatever Render returns
// for a cover image path.
//
// SETUP (do this once)
//   1. https://workers.cloudflare.com -> sign up (free, no card needed).
//   2. Create a Worker (e.g. "swarkatha-image-cdn"), paste this file in.
//   3. Replace ORIGIN below with your real deployed Render backend URL.
//   4. No secrets/env vars needed for this worker.
//   5. Deploy. You'll get a URL like:
//        https://swarkatha-image-cdn.<your-subdomain>.workers.dev
//   6. On Render, set/update:
//        IMAGE_CDN_BASE_URL = https://swarkatha-image-cdn.<your-subdomain>.workers.dev
//      and run scripts/repoint-cover-urls-to-cdn.js once for old covers
//      if you haven't already.
//
// LIMITS: 100,000 requests/day on the free plan, resetting at midnight
// UTC, no bandwidth/egress charge ever. Requests over the limit just
// error until reset — no surprise billing. Paid plan is $5/mo for 10M
// requests/month if you outgrow this.

const ORIGIN = 'https://swarkhatha-7nk1.onrender.com'; // <-- set this to your real Render URL

export default {
  async fetch(request, url_, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname.startsWith('/api/storage/cover/')) {
      return handleCover(request, url, ctx);
    }

    // This worker must only ever serve cover images — everything else
    // (auth, uploads, admin routes, audio streaming) goes elsewhere.
    return new Response('Not found', { status: 404 });
  }
};

async function handleCover(request, url, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), request);

  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const originUrl = ORIGIN.replace(/\/$/, '') + url.pathname;
  const originResponse = await fetch(originUrl, {
    headers: { Accept: request.headers.get('Accept') || '*/*' }
  });

  if (!originResponse.ok) return originResponse;

  const cacheable = new Response(originResponse.body, originResponse);
  cacheable.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  ctx.waitUntil(cache.put(cacheKey, cacheable.clone()));
  return cacheable;
}
