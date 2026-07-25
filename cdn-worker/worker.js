// Free edge cache for SwarKatha cover images, sitting in front of the
// Render backend's GET /api/storage/cover/:accountId/:hash route.
//
// Deploy this once (Cloudflare's free plan -- no credit card, no domain
// required, runs on a *.workers.dev subdomain) and point cover uploads
// at it via the backend's IMAGE_CDN_BASE_URL env var. It:
//
//   1. Only ever proxies GET /api/storage/cover/* -- everything else
//      (auth, uploads, audio streaming, etc.) still goes straight to
//      Render; this Worker never sees it and can't touch it.
//   2. Uses Cloudflare's Cache API to store a copy at the edge the
//      first time ANY user, anywhere, requests a given cover -- every
//      request after that is served straight from Cloudflare's global
//      edge network, in milliseconds, without touching Render or Drime
//      at all (and without caring whether the Render free instance
//      happens to be asleep).
//   3. Treats every cover as cacheable "forever" -- safe because every
//      upload gets a brand new URL (see lib/coverImageStorage.js),
//      nothing is ever overwritten in place, matching the origin's own
//      Cache-Control: public, max-age=31536000, immutable header (see
//      routes/storage.js).
//
// SETUP
//   1. https://workers.cloudflare.com -> sign up (free, no card needed).
//   2. Create a Worker, paste this file in as its code.
//   3. Replace ORIGIN below with your actual deployed Render backend URL.
//   4. Deploy. You'll get a URL like:
//        https://swarkatha-covers.<your-subdomain>.workers.dev
//   5. In Render -> your backend service -> Environment, add:
//        IMAGE_CDN_BASE_URL=https://swarkatha-covers.<your-subdomain>.workers.dev
//      and redeploy. New cover uploads now return a URL through this
//      Worker automatically (see coverBaseUrl() in routes/storage.js).
//   6. For covers uploaded BEFORE step 5, run once from the backend
//      folder:
//        node scripts/repoint-cover-urls-to-cdn.js --to=https://swarkatha-covers.<your-subdomain>.workers.dev
//
// LIMITS TO KNOW ABOUT (free plan): 100,000 requests/day to this
// Worker -- cache HITS still count against that quota, since the Worker
// still has to run to serve them from the edge cache. For most
// small-to-mid catalogs this comfortably covers thousands of daily
// users; if you outgrow it, either the Workers Paid plan ($5/mo, 10M
// requests/month) or moving to a real domain on Cloudflare's plain
// CDN/proxy (unlimited cached bandwidth, no per-request Worker cap --
// see IMAGE_PERFORMANCE.md) removes the ceiling entirely.

const ORIGIN = 'https://your-backend.onrender.com'; // <-- set this to your real Render URL

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Only ever handle cover-image GETs. Anything else 404s here on
    // purpose -- this Worker must never become a general-purpose proxy
    // for the rest of the API.
    if (request.method !== 'GET' || !url.pathname.startsWith('/api/storage/cover/')) {
      return new Response('Not found', { status: 404 });
    }

    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);

    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const originUrl = ORIGIN.replace(/\/$/, '') + url.pathname;
    const originResponse = await fetch(originUrl, {
      headers: { Accept: request.headers.get('Accept') || '*/*' }
    });

    if (!originResponse.ok) return originResponse;

    // Clone the response: one copy goes back to this request, the other
    // is handed to the edge cache in the background (waitUntil keeps the
    // Worker alive long enough to finish the write without delaying the
    // response the user is waiting on).
    const cacheable = new Response(originResponse.body, originResponse);
    cacheable.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    ctx.waitUntil(cache.put(cacheKey, cacheable.clone()));
    return cacheable;
  }
};
