# Cover-image edge cache (Cloudflare Worker)

`worker.js` is a free Cloudflare Worker that caches cover images at
Cloudflare's edge, in front of this backend's `GET
/api/storage/cover/:accountId/:hash` route. It needs no paid plan, no
custom domain, and no changes to Supabase, Render, or Drime.

Full setup steps and background are in `worker.js`'s own header comment,
and in `../IMAGE_PERFORMANCE.md` for the complete picture (this Worker is
one of three free changes, not the whole fix).

Quick version:
1. Deploy `worker.js` at [workers.cloudflare.com](https://workers.cloudflare.com) (free), after setting `ORIGIN` to your real Render URL.
2. Set `IMAGE_CDN_BASE_URL` on the backend to the resulting `*.workers.dev` URL.
3. Run `node scripts/repoint-cover-urls-to-cdn.js --to=<that URL>` once to update covers uploaded before step 2.
