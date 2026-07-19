const express = require('express');
const multer = require('multer');
const supabase = require('../lib/supabaseClient');
const { encrypt, decrypt } = require('../lib/crypto');
const { requireAuth, requireAdmin, signMediaToken, requireMediaAccess } = require('../middleware/auth');
const drime = require('../lib/drime');
const liveMonitor = require('../lib/liveAccountsMonitor');
const imageStorage = require('../lib/imageStorage');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 1024 } }); // 1GB cap
const uploadImage = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB cap for cover images

const PURPOSES = ['music', 'audio_story', 'both'];
const STREAM_TOKEN_TTL_SECONDS = Number(process.env.STREAM_TOKEN_TTL_SECONDS || 900); // 15 min

function loadCreds(account) {
  return JSON.parse(decrypt(account.credentials_enc));
}

function baseUrl(req) {
  return process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
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
 *    field 'kind' = 'album' | 'story' (just a storage-path prefix,
 *    purely cosmetic in the Supabase dashboard).
 *
 *    Used for both flows:
 *      - music: the admin app uploads the track's embedded cover art
 *        (extracted client-side from ID3/MP4 tags) here to get a URL,
 *        then sends that URL as coverImageUrl on POST /api/media.
 *      - audio_story: the admin picks a cover image by hand (episode
 *        files are almost always untagged raw recordings) only when
 *        starting a *new* story; existing stories already have one.
 *
 *    Either way, all images end up in Supabase Storage — see
 *    lib/imageStorage.js — never on Drime, which is audio-only.
 * ------------------------------------------------------------------ */
router.post('/upload-image', requireAuth, requireAdmin, uploadImage.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image provided' });
  const prefix = req.body.kind === 'story' ? 'story' : 'album';
  try {
    const url = await imageStorage.uploadImage({ buffer: req.file.buffer, mime: req.file.mimetype, prefix });
    res.json({ url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
  const { data: item } = await supabase.from('media_items').select('*').eq('id', req.params.mediaItemId).single();
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (!item.storage_hash) return res.status(500).json({ error: 'This item has no storage_hash on file — was it uploaded before the Drime migration?' });

  const token = signMediaToken(item.id, 'stream', STREAM_TOKEN_TTL_SECONDS);
  return res.json({
    url: `${baseUrl(req)}/api/storage/stream/${item.id}?token=${token}`,
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
  const { data: item } = await supabase.from('media_items').select('*').eq('id', req.params.mediaItemId).single();
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (!item.storage_hash) return res.status(500).json({ error: 'This item has no storage_hash on file — was it uploaded before the Drime migration?' });

  const token = signMediaToken(item.id, 'download', STREAM_TOKEN_TTL_SECONDS);
  return res.json({
    url: `${baseUrl(req)}/api/storage/file/${item.id}?token=${token}`,
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
  const { data: item } = await supabase.from('media_items').select('*').eq('id', req.params.mediaItemId).single();
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

module.exports = router;
