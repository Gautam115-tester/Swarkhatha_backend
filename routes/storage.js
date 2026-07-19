const express = require('express');
const multer = require('multer');
const supabase = require('../lib/supabaseClient');
const { encrypt, decrypt } = require('../lib/crypto');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const mediafire = require('../lib/mediafire');
const liveMonitor = require('../lib/liveAccountsMonitor');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 1024 } }); // 1GB cap

const PURPOSES = ['music', 'audio_story', 'both'];

function loadCreds(account) {
  return JSON.parse(decrypt(account.credentials_enc));
}

/* ------------------------------------------------------------------
 * 1) ADD A STORAGE ACCOUNT  (admin only)
 *    Body: { email, password, appId, apiKey, folderKey, purpose, label }
 * ------------------------------------------------------------------ */
router.post('/accounts', requireAuth, requireAdmin, async (req, res) => {
  const { purpose = 'both', label, email, password, appId, apiKey, folderKey } = req.body;
  if (!PURPOSES.includes(purpose)) {
    return res.status(400).json({ error: `purpose must be one of ${PURPOSES.join(', ')}` });
  }
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  try {
    const session = await mediafire.getSessionToken({ email, password, appId, apiKey });
    const info = await mediafire.getAccountInfo({ sessionToken: session.sessionToken });

    const creds = { email, password, appId, apiKey, folderKey };
    const { data: row, error } = await supabase.from('storage_accounts').insert({
      provider: 'mediafire',
      label: label || `MediaFire - ${email}`,
      purpose,
      credentials_enc: encrypt(JSON.stringify(creds)),
      last_known_free_bytes: info.limitBytes - info.usedBytes,
      last_checked_at: new Date().toISOString()
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    liveMonitor.refreshAll(); // don't await — let the response return immediately, cache/SSE catch up within a second
    return res.json({
      account: { id: row.id, label: row.label, provider: 'mediafire', purpose: row.purpose },
      note: 'Streaming works on free MediaFire accounts too, sharing a 50GB/day direct-download bandwidth pool; a paid MediaFire account keeps streaming working past that daily cap and also gets more storage.'
    });
  } catch (e) {
    return res.status(500).json({ error: 'MediaFire account setup failed: ' + (e.response?.data?.message || e.response?.data?.response?.message || e.message) });
  }
});

/* ------------------------------------------------------------------
 * 2) LIST ACCOUNTS + LIVE FREE SPACE + BANDWIDTH  (admin only)
 *    Serves the in-memory cache instantly (refreshed in the
 *    background every STORAGE_REFRESH_INTERVAL_MS — see
 *    lib/liveAccountsMonitor.js). Pass ?force=true to block for a
 *    fresh MediaFire pull right now instead of the cached snapshot
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
 *     This connection is also what turns the monitor's 8s MediaFire
 *     poll on and off: connecting calls liveMonitor.acquire(), which
 *     starts the poll if this is the first admin connected; the
 *     req.on('close') handler (fires when the admin app is closed,
 *     backgrounded past its socket timeout, or loses connectivity)
 *     calls liveMonitor.release(), which stops the poll once the last
 *     admin has disconnected. So: admin app open -> checks MediaFire
 *     every 8s; admin app closed -> stops checking. Multiple admins
 *     open at once still share one 8s poll, not one each.
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
 *    auto-pick the best-fitting MediaFire account)
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
      return res.status(507).json({ error: `No matching '${mediaType}' (or 'both') MediaFire storage account found` });
    }
    // Prefer the account with the most last_known_free_bytes.
    account = accounts.sort((a, b) => (b.last_known_free_bytes ?? 0) - (a.last_known_free_bytes ?? 0))[0];
  }

  try {
    const creds = loadCreds(account);
    const session = await mediafire.getSessionToken({ email: creds.email, password: creds.password, appId: creds.appId, apiKey: creds.apiKey });
    const uploaded = await mediafire.uploadFile({
      sessionToken: session.sessionToken,
      buffer: req.file.buffer,
      fileName: req.file.originalname,
      folderKey: creds.folderKey
    });

    return res.json({
      accountId: account.id,
      accountLabel: account.label,
      provider: 'mediafire',
      storageFileId: uploaded.quickKey,
      storagePath: uploaded.fileName,
      sizeBytes: requiredBytes
    });
  } catch (e) {
    res.status(500).json({ error: 'Upload failed: ' + (e.response?.data?.message || e.message) });
  }
});

/* ------------------------------------------------------------------
 * 4) STREAM LINK  (any logged-in listener)
 * ------------------------------------------------------------------ */
router.get('/stream-url/:mediaItemId', requireAuth, async (req, res) => {
  const { data: item } = await supabase.from('media_items').select('*').eq('id', req.params.mediaItemId).single();
  if (!item) return res.status(404).json({ error: 'Not found' });

  const { data: account } = await supabase.from('storage_accounts').select('*').eq('id', item.storage_account_id).single();
  if (!account) return res.status(404).json({ error: 'Storage account not found' });

  try {
    const creds = loadCreds(account);
    const session = await mediafire.getSessionToken({ email: creds.email, password: creds.password, appId: creds.appId, apiKey: creds.apiKey });
    const link = await mediafire.getStreamLink({ sessionToken: session.sessionToken, quickKey: item.storage_file_id });
    return res.json({ url: link.url, freeBandwidthMB: link.freeBandwidthMB, provider: 'mediafire' });
  } catch (e) {
    res.status(503).json({ error: 'Failed to resolve stream link: ' + (e.response?.data?.message || e.message) });
  }
});

/* ------------------------------------------------------------------
 * 5) DOWNLOAD LINK  (any logged-in listener) — for saving music/audio
 *    stories offline. Uses the same direct_download link type as
 *    stream-url (MediaFire has no separate raw-bytes link for
 *    "download" vs "stream" — normal_download is a web page, not
 *    fetchable file bytes, so it can't back an automated download).
 *    Both draw from the same shared 50GB/day free bandwidth pool.
 * ------------------------------------------------------------------ */
router.get('/download-url/:mediaItemId', requireAuth, async (req, res) => {
  const { data: item } = await supabase.from('media_items').select('*').eq('id', req.params.mediaItemId).single();
  if (!item) return res.status(404).json({ error: 'Not found' });

  const { data: account } = await supabase.from('storage_accounts').select('*').eq('id', item.storage_account_id).single();
  if (!account) return res.status(404).json({ error: 'Storage account not found' });

  try {
    const creds = loadCreds(account);
    const session = await mediafire.getSessionToken({ email: creds.email, password: creds.password, appId: creds.appId, apiKey: creds.apiKey });
    const link = await mediafire.getDownloadLink({ sessionToken: session.sessionToken, quickKey: item.storage_file_id });
    return res.json({ url: link.url, fileName: item.storage_path, freeBandwidthMB: link.freeBandwidthMB, provider: 'mediafire' });
  } catch (e) {
    res.status(503).json({ error: 'Failed to resolve download link: ' + (e.response?.data?.message || e.message) });
  }
});

module.exports = router;
