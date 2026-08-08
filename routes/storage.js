const express = require('express');
const multer = require('multer');
const supabase = require('../lib/supabaseClient');
const { encrypt, decrypt } = require('../lib/crypto');
const { requireAuth, requireAdmin, signMediaToken, requireMediaAccess } = require('../middleware/auth');
const drime = require('../lib/drime');
const liveMonitor = require('../lib/liveAccountsMonitor');
const coverImageStorage = require('../lib/coverImageStorage');
const coverImageCache = require('../lib/coverImageCache');
const accountCache = require('../lib/accountCache');
const mediaItemCache = require('../lib/mediaItemCache');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 1024 } }); // 1GB cap
const uploadImage = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB cap for cover images

// 'image' is its own purpose, deliberately separate from 'both' (which
// has always meant "music & audio_story") — see
// migration_image_storage_drime.sql for why that separation matters for
// the public cover proxy route below.
const PURPOSES = ['music', 'audio_story', 'both', 'image'];
const STREAM_TOKEN_TTL_SECONDS = Number(process.env.STREAM_TOKEN_TTL_SECONDS || 900); // 15 min

function loadCreds(account) {
  return JSON.parse(decrypt(account.credentials_enc));
}

function baseUrl(req) {
  return process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
}

// Cover images are the one thing worth putting behind a free CDN/edge
// cache (see /cdn-worker) — a fixed image, requested over and over by
// thousands of listeners, is exactly what edge caching is for, and it
// takes that traffic off this Render instance (and Drime) entirely once
// warm. When IMAGE_CDN_BASE_URL is set, newly-uploaded covers get a URL
// pointing at that CDN instead of straight at this backend; the
// underlying GET /cover/:accountId/:hash route below still works
// standalone either way, so this is purely additive — nothing breaks if
// it's left unset. scripts/repoint-cover-urls-to-cdn.js updates
// already-uploaded covers to match once this is configured.
function coverBaseUrl(req) {
  return process.env.IMAGE_CDN_BASE_URL || baseUrl(req);
}

// Audio is the bandwidth-heavy counterpart to cover images above — every
// stream, seek, and download used to pipe full audio bytes through this
// Render instance, which is what burns through Render's bandwidth
// allowance. When AUDIO_CDN_BASE_URL is set (pointed at the Cloudflare
// Worker in /cdn-worker, once it's been extended to handle
// /api/storage/stream and /api/storage/file too), newly-minted
// stream-url/download-url responses point there instead, and the Worker
// fetches straight from Drime — this backend's egress meter barely
// moves. The underlying GET /stream/:id and /file/:id routes below still
// work standalone either way, so this is purely additive: nothing breaks
// if it's left unset, it just keeps proxying through Render as before.
function audioBaseUrl(req) {
  return process.env.AUDIO_CDN_BASE_URL || baseUrl(req);
}

/* ------------------------------------------------------------------
 * 1) ADD A STORAGE ACCOUNT  (admin only)
 *    Body: { accessToken, workspaceId, folderId, purpose, label }
 *
 *    Unlike MediaFire, Drime has no email/password login step here —
 *    accessToken is a personal access token the admin creates once at
 *    https://app.drime.cloud/account-settings#developers ("Create a
 *    token") and pastes in below. workspaceId defaults to 0 (personal
 *    workspace); folderId optionally scopes uploads to one Drime folder.
 * ------------------------------------------------------------------ */
router.post('/accounts', requireAuth, requireAdmin, async (req, res) => {
  const { purpose = 'both', label, accessToken, workspaceId, folderId } = req.body;
  if (!PURPOSES.includes(purpose)) {
    return res.status(400).json({ error: `purpose must be one of ${PURPOSES.join(', ')}` });
  }
  if (!accessToken) {
    return res.status(400).json({ error: 'accessToken is required (create one at https://app.drime.cloud/account-settings#developers)' });
  }

  // Each Drime call is wrapped separately so a failure names exactly
  // which step it came from — an invalid token fails loggedUser, while
  // a valid-but-permission-limited token could still fail space-usage.
  let user;
  try {
    user = await drime.getLoggedUser({ accessToken });
  } catch (e) {
    const msg = e.response?.data?.message || e.message;
    console.error('[storage/accounts] getLoggedUser failed:', msg);
    return res.status(500).json({ error: `Drime token check failed (cli/loggedUser): ${msg}` });
  }

  let usage;
  try {
    usage = await drime.getSpaceUsage({ accessToken });
  } catch (e) {
    const msg = e.response?.data?.message || e.message;
    console.error('[storage/accounts] getSpaceUsage failed:', msg);
    return res.status(500).json({ error: `Drime storage usage fetch failed (user/space-usage): ${msg}` });
  }

  try {
    const creds = { accessToken, workspaceId: workspaceId ?? 0, folderId: folderId ?? null };
    const { data: row, error } = await supabase.from('storage_accounts').insert({
      provider: 'drime',
      label: label || `Drime - ${user.email || user.display_name || 'account'}`,
      purpose,
      credentials_enc: encrypt(JSON.stringify(creds)),
      last_known_free_bytes: usage.availableBytes,
      last_known_used_bytes: usage.usedBytes,
      last_known_total_bytes: usage.limitBytes,
      last_checked_at: new Date().toISOString()
    }).select().single();
    if (error) return res.status(500).json({ error: `Saving the account failed (database): ${error.message}` });
    liveMonitor.refreshAll(); // don't await — let the response return immediately, cache/SSE catch up within a second
    return res.json({
      account: { id: row.id, label: row.label, provider: 'drime', purpose: row.purpose }
    });
  } catch (e) {
    console.error('[storage/accounts] unexpected error after Drime token check succeeded:', e.message);
    return res.status(500).json({ error: `Saving the account failed: ${e.message}` });
  }
});

/* ------------------------------------------------------------------
 * 2) LIST ACCOUNTS + LIVE FREE SPACE  (admin only)
 *    Serves the in-memory cache instantly (refreshed in the
 *    background every STORAGE_REFRESH_INTERVAL_MS — see
 *    lib/liveAccountsMonitor.js). Pass ?force=true to block for a
 *    fresh Drime pull right now instead of the cached snapshot
 *    (useful right after adding/editing an account).
 * ------------------------------------------------------------------ */
router.get('/accounts', requireAuth, requireAdmin, async (req, res) => {
  if (req.query.force === 'true') {
    await liveMonitor.refreshAll();
  }
  const snapshot = liveMonitor.getSnapshot();
  if (snapshot.length === 0) {
    // Cache hasn't populated yet (e.g. right after server boot) — do
    // one synchronous refresh so the admin doesn't see an empty list.
    await liveMonitor.refreshAll();
  }
  res.json({ accounts: liveMonitor.getSnapshot(), refreshIntervalMs: Number(process.env.STORAGE_REFRESH_INTERVAL_MS || 8000) });
});

/* ------------------------------------------------------------------
 * 2b) LIVE STREAM (admin only) — Server-Sent Events. Pushes the
 *     current cached snapshot once a second so a dashboard can just
 *     render whatever arrives, no client-side polling/timers needed.
 *
 *     This connection is also what turns the monitor's background
 *     Drime poll on and off: connecting calls liveMonitor.acquire(),
 *     which starts the poll if this is the first admin connected; the
 *     req.on('close') handler calls liveMonitor.release(), which stops
 *     the poll once the last admin has disconnected.
 * ------------------------------------------------------------------ */
router.get('/accounts/live', requireAuth, requireAdmin, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  liveMonitor.acquire();
  send(liveMonitor.getSnapshot());

  const heartbeat = setInterval(() => send(liveMonitor.getSnapshot()), 1000);
  const onUpdate = (snapshot) => send(snapshot);
  liveMonitor.on('update', onUpdate);

  req.on('close', () => {
    clearInterval(heartbeat);
    liveMonitor.off('update', onUpdate);
    liveMonitor.release();
  });
});

// Admin: rename/re-tag an account
router.patch('/accounts/:id', requireAuth, requireAdmin, async (req, res) => {
  const { purpose, label } = req.body;
  if (purpose && !PURPOSES.includes(purpose)) {
    return res.status(400).json({ error: `purpose must be one of ${PURPOSES.join(', ')}` });
  }
  const update = {};
  if (purpose) update.purpose = purpose;
  if (label) update.label = label;
  if (Object.keys(update).length === 0) return res.status(400).json({ error: 'Nothing to update' });

  const { data, error } = await supabase.from('storage_accounts').update(update).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  accountCache.invalidate(req.params.id); // see lib/accountCache.js — don't wait out the TTL on an edit
  res.json({ account: data });
});

/* ------------------------------------------------------------------
 * 3) UPLOAD  (admin picks an account, or omits accountId to
 *    auto-pick the best-fitting Drime account)
 * ------------------------------------------------------------------ */
router.post('/upload', requireAuth, requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  const { accountId, mediaType } = req.body;
  const requiredBytes = req.file.size;

  if (!mediaType || !['music', 'audio_story'].includes(mediaType)) {
    return res.status(400).json({ error: "mediaType is required and must be 'music' or 'audio_story'" });
  }

  let account;
  if (accountId) {
    const { data } = await supabase.from('storage_accounts').select('*').eq('id', accountId).single();
    account = data;
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (account.purpose !== 'both' && account.purpose !== mediaType) {
      return res.status(400).json({ error: `This account is dedicated to '${account.purpose}', not '${mediaType}'.` });
    }
  } else {
    const { data: accounts } = await supabase
      .from('storage_accounts').select('*').eq('is_active', true).in('purpose', [mediaType, 'both']);
    if (!accounts || accounts.length === 0) {
      return res.status(507).json({ error: `No matching '${mediaType}' (or 'both') Drime storage account found` });
    }
    // Prefer the account with the most last_known_free_bytes.
    account = accounts.sort((a, b) => (b.last_known_free_bytes ?? 0) - (a.last_known_free_bytes ?? 0))[0];
  }

  try {
    const creds = loadCreds(account);
    const uploaded = await drime.uploadFile({
      accessToken: creds.accessToken,
      buffer: req.file.buffer,
      fileName: req.file.originalname,
      mime: req.file.mimetype,
      workspaceId: creds.workspaceId,
      folderId: creds.folderId
    });

    return res.json({
      accountId: account.id,
      accountLabel: account.label,
      provider: 'drime',
      storageFileId: uploaded.fileEntryId,
      storageHash: uploaded.hash,
      storagePath: uploaded.fileName,
      sizeBytes: uploaded.fileSizeBytes || requiredBytes
    });
  } catch (e) {
    res.status(500).json({ error: 'Upload failed: ' + (e.response?.data?.message || e.message) });
  }
});

/* ------------------------------------------------------------------
 * 3b) UPLOAD COVER IMAGE  (admin only)
 *    Body: multipart field 'image' (jpg/png/webp/gif, 10MB cap) +
 *    field 'kind' = 'album' | 'story' (just a filename hint) +
 *    optional field 'accountId' to pin a specific 'image'-purpose
 *    Drime account instead of auto-picking the one with the most
 *    free space.
 *
 *    Used for both flows:
 *      - music: the admin app uploads the track's embedded cover art
 *        (extracted client-side from ID3/MP4 tags) here to get a URL,
 *        then sends that URL as coverImageUrl on POST /api/media.
 *      - audio_story: the admin picks a cover image by hand (episode
 *        files are almost always untagged raw recordings) only when
 *        starting a *new* story; existing stories already have one.
 *
 *    Cover images live on a dedicated 'image'-purpose Drime account —
 *    see lib/coverImageStorage.js and migration_image_storage_drime.sql
 *    (previously: a public Supabase Storage bucket). The returned
 *    `url` points at this backend's own public GET /cover/:accountId/
 *    :hash route below, since Drime itself has no credential-free
 *    direct-link type (same reason stream/download are proxied).
 * ------------------------------------------------------------------ */
router.post('/upload-image', requireAuth, requireAdmin, uploadImage.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image provided' });
  const prefix = req.body.kind === 'story' ? 'story' : 'album';
  try {
    const uploaded = await coverImageStorage.uploadImage({
      buffer: req.file.buffer,
      prefix,
      accountId: req.body.accountId || undefined
    });
    res.json({
      url: `${coverBaseUrl(req)}/api/storage/cover/${uploaded.accountId}/${uploaded.storageHash}`,
      accountId: uploaded.accountId,
      storageFileId: uploaded.storageFileId,
      storageHash: uploaded.storageHash,
      sizeBytes: uploaded.sizeBytes
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------
 * 3c) SERVE COVER IMAGE  (public, no auth)
 *    Drime's file-bytes endpoint always needs a Bearer token, so this
 *    proxies it server-side — same shape as /stream and /file below,
 *    except deliberately UNAUTHENTICATED: cover art was a public
 *    Supabase Storage URL before this migration, and every screen in
 *    both Flutter apps (CachedNetworkImage etc.) already just hits
 *    `coverImageUrl` directly with no auth headers attached. Making
 *    this route require a token would mean touching every image
 *    widget in both apps just to add headers.
 *
 *    This is safe specifically BECAUSE `accountId` must resolve to an
 *    account whose purpose is exactly 'image' (never 'both', which
 *    holds real music/audio_story files) — see the comment on
 *    PURPOSES above and in migration_image_storage_drime.sql. An
 *    'image'-purpose account should only ever contain cover art, so
 *    this route can never be used to pull gated audio off Drime.
 *
 *    PERFORMANCE: unlike /stream and /file below, this does NOT stream
 *    straight through to Drime on every request. Cover images are
 *    small and immutable per URL (a fresh hash is minted on every
 *    upload — see lib/coverImageStorage.js), which makes them ideal to
 *    cache in full:
 *      - accountCache avoids a Supabase round trip on every request
 *        for the account row (see lib/accountCache.js).
 *      - coverImageCache holds the actual image bytes in memory, keyed
 *        by accountId+hash, so a second request for the same cover —
 *        from any user — never touches Drime at all (see
 *        lib/coverImageCache.js, including in-flight request
 *        coalescing and the strict 50MB memory cap).
 *    Put a CDN/edge cache in front of this route too (see
 *    /cdn-worker) and the large majority of requests never reach this
 *    instance in the first place, which also sidesteps Render free-tier
 *    cold starts for anything already warmed at the edge.
 * ------------------------------------------------------------------ */
router.get('/cover/:accountId/:hash', async (req, res) => {
  const { accountId, hash } = req.params;
  const account = await accountCache.getAccount(accountId);
  if (!account || account.purpose !== 'image' || !account.is_active) {
    return res.status(404).json({ error: 'Not found' });
  }

  try {
    const cacheKey = `${accountId}:${hash}`;
    const { buffer, contentType } = await coverImageCache.getOrFetch(cacheKey, async () => {
      const creds = loadCreds(account);
      const file = await drime.getFileBuffer({ accessToken: creds.accessToken, hash });
      return { buffer: file.buffer, contentType: file.contentType, size: file.buffer.length };
    });

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', buffer.length);
    // One year: every upload gets a fresh, unique filename and is never
    // overwritten in place, so a cached copy under this exact
    // accountId+hash URL can never go stale. Matches the old Supabase
    // Storage bucket's cache policy exactly, and is what makes the
    // in-memory cache above (and any CDN in front of this route) safe
    // to hold onto indefinitely.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.status(200).send(buffer);
  } catch (e) {
    if (e.status === 404) {
      return res.status(404).json({ error: 'Image not found' });
    }
    res.status(503).json({ error: 'Failed to resolve image from Drime: ' + (e.response?.data?.message || e.message) });
  }
});

/* ------------------------------------------------------------------
 * 3d) IMAGE CACHE STATS  (admin only) — sanity-check that the
 *    in-memory cover cache from 3c is actually filling up/being hit,
 *    without needing Render shell access.
 * ------------------------------------------------------------------ */
router.get('/image-cache-stats', requireAuth, requireAdmin, (req, res) => {
  res.json(coverImageCache.stats());
});

/* ------------------------------------------------------------------
 * 3e) MEDIA ITEM (metadata) CACHE STATS  (admin only) — same purpose
 *    as 3d, for lib/mediaItemCache.js (the media_items row lookup
 *    cache used by stream-url, download-url, and the stream/file
 *    proxy below).
 * ------------------------------------------------------------------ */
router.get('/media-item-cache-stats', requireAuth, requireAdmin, (req, res) => {
  res.json(mediaItemCache.stats());
});

/* ------------------------------------------------------------------
 * 4) STREAM URL  (any logged-in listener)
 *
 *    Drime's file-bytes endpoint requires the storage account's Bearer
 *    token on every request, so — unlike MediaFire's direct_download —
 *    it can never be handed straight to the app. Instead this mints a
 *    short-lived, single-purpose token (see middleware/auth.js) and
 *    returns a URL back into THIS backend's own /stream/:id proxy,
 *    which fetches from Drime server-side and pipes the bytes through.
 * ------------------------------------------------------------------ */
router.get('/stream-url/:mediaItemId', requireAuth, async (req, res) => {
  const item = await mediaItemCache.getOrFetch(req.params.mediaItemId, async () => {
    const { data } = await supabase.from('media_items').select('*').eq('id', req.params.mediaItemId).single();
    return data || null;
  });
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (!item.storage_hash) return res.status(500).json({ error: 'This item has no storage_hash on file — was it uploaded before the Drime migration?' });

  const token = signMediaToken(item.id, 'stream', STREAM_TOKEN_TTL_SECONDS);
  return res.json({
    url: `${audioBaseUrl(req)}/api/storage/stream/${item.id}?token=${token}`,
    expiresInSeconds: STREAM_TOKEN_TTL_SECONDS,
    provider: 'drime'
  });
});

/* ------------------------------------------------------------------
 * 5) DOWNLOAD URL  (any logged-in listener) — for saving music/audio
 *    stories offline. Same proxy approach as stream-url, just pointed
 *    at /file/:id (which additionally sets a Content-Disposition:
 *    attachment header so it saves rather than plays inline).
 * ------------------------------------------------------------------ */
router.get('/download-url/:mediaItemId', requireAuth, async (req, res) => {
  const item = await mediaItemCache.getOrFetch(req.params.mediaItemId, async () => {
    const { data } = await supabase.from('media_items').select('*').eq('id', req.params.mediaItemId).single();
    return data || null;
  });
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (!item.storage_hash) return res.status(500).json({ error: 'This item has no storage_hash on file — was it uploaded before the Drime migration?' });

  const token = signMediaToken(item.id, 'download', STREAM_TOKEN_TTL_SECONDS);
  return res.json({
    url: `${audioBaseUrl(req)}/api/storage/file/${item.id}?token=${token}`,
    fileName: item.storage_path,
    expiresInSeconds: STREAM_TOKEN_TTL_SECONDS,
    provider: 'drime'
  });
});

/* ------------------------------------------------------------------
 * 6) PROXY ROUTES — actually stream the bytes from Drime.
 *    Gated by requireMediaAccess(), which accepts either a normal
 *    listener JWT or the short-lived ?token= minted above. Forwards
 *    Range so audio players can seek/scrub during playback.
 * ------------------------------------------------------------------ */
async function proxyMedia(req, res, { forceDownload }) {
  // This runs on every stream/seek/download request (range requests for
  // scrubbing re-hit this route repeatedly for the same id), so it's the
  // hottest of the three media_items lookups — see lib/mediaItemCache.js.
  const item = await mediaItemCache.getOrFetch(req.params.mediaItemId, async () => {
    const { data } = await supabase.from('media_items').select('*').eq('id', req.params.mediaItemId).single();
    return data || null;
  });
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (!item.storage_hash) return res.status(500).json({ error: 'This item has no storage_hash on file' });

  const { data: account } = await supabase.from('storage_accounts').select('*').eq('id', item.storage_account_id).single();
  if (!account) return res.status(404).json({ error: 'Storage account not found' });

  try {
    const creds = loadCreds(account);
    const upstream = await drime.getFileStream({ accessToken: creds.accessToken, hash: item.storage_hash, range: req.headers.range });
    if (upstream.status >= 400) {
      return res.status(502).json({ error: `Drime returned ${upstream.status} while resolving this file` });
    }

    res.status(upstream.status); // 200 (full) or 206 (partial/range)
    for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      if (upstream.headers[header]) res.setHeader(header, upstream.headers[header]);
    }
    // Force Accept-Ranges: bytes even if Drime omitted it. Some audio
    // players (esp. on Android/ExoPlayer and iOS AVPlayer) only attempt
    // byte-range requests — and therefore only start playing after the
    // first small chunk instead of waiting for the whole file — when
    // this header is present on the *initial* response. Missing it is a
    // common root cause of "streaming" actually behaving like a full
    // download before playback starts.
    if (!res.getHeader('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');
    if (!forceDownload) {
      // Explicitly mark this as inline/streamable (never a download
      // prompt) and disable caching of what may be a short-lived signed
      // proxy response, so the player always re-requests through a
      // fresh token instead of trying to reuse a stale cached copy.
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('Cache-Control', 'no-store');
    }
    if (forceDownload) {
      const fileName = (item.storage_path || item.title || 'download').replace(/"/g, '');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    }
    upstream.data.pipe(res);
  } catch (e) {
    res.status(503).json({ error: 'Failed to resolve file from Drime: ' + (e.response?.data?.message || e.message) });
  }
}

router.get('/stream/:mediaItemId', requireMediaAccess('stream'), (req, res) => proxyMedia(req, res, { forceDownload: false }));
router.get('/file/:mediaItemId', requireMediaAccess('download'), (req, res) => proxyMedia(req, res, { forceDownload: true }));

/* ------------------------------------------------------------------
 * 7) RESOLVE MEDIA  (internal only — the Cloudflare audio Worker, not
 *    the Flutter app) — replaces proxyMedia() above as the audio path
 *    once AUDIO_CDN_BASE_URL is set. Instead of piping the file itself,
 *    this decrypts the item's storage-account credentials (same lookup
 *    proxyMedia does) and hands back tiny JSON: the Drime access token,
 *    the file hash, and Drime's API base. The Worker then fetches the
 *    actual bytes straight from Drime and streams them to the listener
 *    — this response is a few hundred bytes regardless of file size, so
 *    it barely registers against Render's bandwidth cap even at high
 *    stream volume.
 *
 *    Gated by a shared secret (WORKER_INTERNAL_SECRET) known only to
 *    the Worker — never by a listener JWT or the short-lived
 *    signMediaToken() from stream-url/download-url above, both of which
 *    the Worker verifies itself before ever calling this. If this
 *    secret is unset, the endpoint refuses every request rather than
 *    silently handing out Drime credentials to whoever asks.
 * ------------------------------------------------------------------ */
router.get('/resolve-media/:mediaItemId', async (req, res) => {
  const secret = process.env.WORKER_INTERNAL_SECRET;
  if (!secret || req.headers['x-internal-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const item = await mediaItemCache.getOrFetch(req.params.mediaItemId, async () => {
      const { data } = await supabase.from('media_items').select('*').eq('id', req.params.mediaItemId).single();
      return data || null;
    });
    if (!item) return res.status(404).json({ error: 'Not found' });
    if (!item.storage_hash) return res.status(500).json({ error: 'This item has no storage_hash on file' });

    const { data: account } = await supabase.from('storage_accounts').select('*').eq('id', item.storage_account_id).single();
    if (!account) return res.status(404).json({ error: 'Storage account not found' });

    const creds = loadCreds(account);
    res.json({
      accessToken: creds.accessToken,
      hash: item.storage_hash,
      fileName: (item.storage_path || item.title || 'download'),
      drimeApiBase: process.env.DRIME_API_BASE || 'https://app.drime.cloud/api/v1'
    });
  } catch (e) {
    console.error('resolve-media error:', e);
    res.status(503).json({ error: 'Failed to resolve media: ' + (e.response?.data?.message || e.message) });
  }
});

module.exports = router;