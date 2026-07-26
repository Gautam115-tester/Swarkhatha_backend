# Why cover images were taking ~1 minute, and what changed

## The actual cause

It wasn't the images. Every cover image load went through this path:

```
Flutter app -> Render (Node backend) -> Supabase (look up which Drime
account owns this image) -> Drime API (authenticate + download the
bytes) -> back through Render -> Flutter app
```

Two things made that slow, and they compound:

1. **Render's free tier sleeps after ~15 minutes idle.** Waking it back
   up (a "cold start") can take 30-60+ seconds. If the first request
   after a quiet period is a user opening the app and loading cover art,
   that's your 1-minute wait, right there. This was already flagged in
   `DEPLOYMENT.md` ("upgrade to a paid instance before letting real
   users hit it") — the code was written expecting a paid instance.
2. **There was no caching anywhere on the server side.** Every single
   image request — even the same album cover, requested a minute apart
   by two different users — re-ran a Supabase lookup and a fresh
   authenticated Drime download. With millions of images and 10,000
   users, that's a lot of repeat, avoidable work.

Your Flutter app itself was already doing the right thing
(`CachedNetworkImage` everywhere), so once an image loads once *on a
given device*, it's fine. The problem was every *first* load, on every
device, for every image — which at your scale is most loads.

## What changed (already in this codebase, no cost)

- **`lib/coverImageCache.js`** — an in-memory cache that holds actual
  cover image bytes, strictly capped at 50MB total (any single image
  bigger than that is served but not cached, so it can't wipe out the
  rest of the cache). The first time anyone requests a given cover, it's
  fetched from Drime and cached; every request after that (from any
  user) is served straight from memory. Includes request coalescing, so
  if 50 users open a newly-published album in the same second, that's
  one Drime fetch, not 50.
- **`lib/mediaItemCache.js`** — caches the lightweight `media_items` row
  lookup (title, storage hash, account id, cover path, etc — never the
  audio/video bytes themselves) that `/stream-url`, `/download-url`, and
  the `/stream` and `/file` proxy routes each need on every request,
  including every seek/scrub. Capped at 10MB with a 6-hour TTL — long,
  because both write paths that can change a cached row (delete, and an
  admin re-covering an album/story, which propagates a new cover onto
  every existing track/episode) call `invalidate()` explicitly for every
  affected id the moment the write happens, so correctness doesn't
  depend on the TTL for the cases actually expected to occur. The TTL is
  just a distant backstop for anything unanticipated.
- **`lib/accountCache.js`** — removes the Supabase database round-trip
  that used to run on *every* image request just to look up which Drime
  account and credentials to use.
- **`lib/drime.js`** — Drime API calls now reuse HTTP connections
  (keep-alive) instead of opening a fresh TCP+TLS handshake per request,
  and cover images are fetched as a single buffered download rather than
  a proxied stream, so they're cacheable.
- These are all in-process changes — nothing to configure, they take
  effect on your next deploy. Both caches' hard caps mean the memory
  they can ever add is fixed (50MB + 10MB) regardless of how many of
  your 10,000 users hit the service at once — that ceiling is what
  keeps caching itself from ever being the thing that OOMs a Render
  instance.

**On their own, these fix the "one popular image is slow for everyone"
problem, but not the cold-start problem** — the very first request after
Render sleeps is still slow, because nothing has served that image yet
for the in-memory cache to have it. That's what the next two steps are
for, and both are free.

## Step 1: Put a free CDN in front of cover images (biggest win)

`cdn-worker/worker.js` is a Cloudflare Worker that caches cover images
at Cloudflare's global edge network. It's free, needs no domain
purchase (`*.workers.dev` subdomain), and needs no changes to Supabase,
Render, or Drime.

Once set up, the *large majority* of image requests never reach Render
at all — they're served from Cloudflare's edge in milliseconds,
regardless of whether Render is asleep. This is the single biggest
lever available without spending money, because it removes Render's
cold start from the equation entirely for any image that's been loaded
before by anyone.

Setup (see the header comment in `cdn-worker/worker.js` for full detail):
1. Sign up free at workers.cloudflare.com (no card required).
2. Create a Worker, paste in `cdn-worker/worker.js`, set `ORIGIN` to
   your real Render URL, deploy.
3. Set `IMAGE_CDN_BASE_URL` in Render's environment variables to the
   resulting `https://<name>.<you>.workers.dev` URL, redeploy the
   backend.
4. Run `node scripts/repoint-cover-urls-to-cdn.js --to=<that URL>` once
   to update covers uploaded before step 3 (new uploads use it
   automatically).

**Honest limit:** the free Workers plan allows 100,000 requests/day
(cache hits count too, since the Worker still runs to serve them). For
most usage patterns at your scale that's a solid amount of headroom, but
if you have a genuinely huge daily active fraction of 10,000 users all
loading many images, you could brush against it on a peak day. If that
happens, the options are the $5/mo Workers Paid plan (10M requests/month
— genuinely cheap, but it is money), or moving to a real domain on
Cloudflare's plain CDN/proxy instead of Workers, which has no
per-request cap on the free plan but requires owning a domain (there are
free-domain options like eu.org that can be pointed at Cloudflare's
nameservers, if you want to stay at $0). I'm flagging this rather than
hiding it — start with the Worker, watch your actual traffic, and only
worry about this if you get close to the ceiling.

## Step 2: Keep Render from sleeping (optional, has a real tradeoff)

You can stop Render's free instance from sleeping by having something
ping `GET /health` every 5-10 minutes — services like
[UptimeRobot](https://uptimerobot.com) or
[cron-job.org](https://cron-job.org) do this for free.

**Be aware of the tradeoff:** Render's free tier includes 750
instance-hours/month. Pinging it constantly to stay awake 24/7 uses
close to all of that (~720-744 hours), which risks the service being
suspended for the rest of the month once the quota is hit — which would
cause *worse*, total downtime right when you're trying to avoid partial
slowness. If you use this, consider only keeping it awake during your
actual peak usage hours (e.g. pinging for 16-18 hours/day rather than
24), leaving headroom in the monthly quota.

Given Step 1 already removes Render from the path for most requests
once the edge cache is warm, this step matters less than it would
without a CDN in front — I'd treat it as a smaller, optional addition,
not a required one.

## Step 3 (already done): don't over-fetch on the client

Not part of this change set, but worth knowing: your cover images are
already resized server-side to a 1000px max dimension at JPEG quality 82
before upload (see `lib/coverImageStorage.js`), so you're not shipping
oversized files. The Flutter app's cache manager and thumbnail decode
sizing are covered separately in the app README.

## Verifying it's working

After deploying the backend changes, `GET /api/storage/image-cache-stats`
(admin JWT required) shows how many images and bytes are currently held
in the in-memory cache — a rising `entries` count as users browse
confirms the cache is being hit. `GET /api/storage/media-item-cache-stats`
shows the same thing for the metadata lookup cache (also `hits`,
`misses`, `evictions`, and `expirations`).
