const express = require('express');
const multer = require('multer');
const supabase = require('../lib/supabaseClient');
const { encrypt, decrypt } = require('../lib/crypto');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const mediafire = require('../lib/mediafire');

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
    return res.json({
      account: { id: row.id, label: row.label, provider: 'mediafire', purpose: row.purpose },
      note: 'Streaming works on free MediaFire accounts too, sharing a 50GB/day direct-download bandwidth pool; a paid MediaFire account keeps streaming working past that daily cap and also gets more storage.'
    });
  } catch (e) {
    return res.status(500).json({ error: 'MediaFire account setup failed: ' + (e.response?.data?.message || e.response?.data?.response?.message || e.message) });
  }
});

/* ------------------------------------------------------------------
 * 2) LIST ACCOUNTS + LIVE FREE SPACE  (admin only)
 * ------------------------------------------------------------------ */
router.get('/accounts', requireAuth, requireAdmin, async (req, res) => {
  const { data: accounts, error } = await supabase.from('storage_accounts').select('*').eq('is_active', true);
  if (error) return res.status(500).json({ error: error.message });

  const results = await Promise.all(accounts.map(async (acct) => {
    try {
      const creds = loadCreds(acct);
      const session = await mediafire.getSessionToken({ email: creds.email, password: creds.password, appId: creds.appId, apiKey: creds.apiKey });
      const info = await mediafire.getAccountInfo({ sessionToken: session.sessionToken });
      const freeBytes = info.limitBytes - info.usedBytes;

      await supabase.from('storage_accounts').update({
        last_known_free_bytes: freeBytes, last_checked_at: new Date().toISOString()
      }).eq('id', acct.id);

      return {
        id: acct.id, label: acct.label, provider: acct.provider, purpose: acct.purpose,
        freeBytes, freeGB: (freeBytes / 1e9).toFixed(2),
        usedBytes: info.usedBytes, totalBytes: info.limitBytes, status: 'ok'
      };
    } catch (e) {
      return { id: acct.id, label: acct.label, provider: acct.provider, purpose: acct.purpose, status: 'error', error: e.message };
    }
  }));

  res.json({ accounts: results.sort((a, b) => (b.freeBytes || Infinity) - (a.freeBytes || Infinity)) });
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
    return res.json({
      url: link.url,
      direct: link.direct,
      freeBandwidthMB: link.freeBandwidthMB,
      provider: 'mediafire',
      note: link.direct
        ? undefined
        : 'MediaFire could not issue a direct streaming link right now (e.g. this account\'s free 50GB/day direct-download bandwidth may be exhausted for today) — this is a view-page link, not directly playable.'
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to resolve stream link: ' + (e.response?.data?.message || e.message) });
  }
});

/* ------------------------------------------------------------------
 * 5) DOWNLOAD LINK  (any logged-in listener) — for saving music/audio
 *    stories offline, as opposed to stream-url which is for inline
 *    playback. Works on free MediaFire accounts too, unlike the
 *    direct_download link stream-url prefers.
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
    return res.json({ url: link.url, fileName: link.fileName || item.storage_path, provider: 'mediafire' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to resolve download link: ' + (e.response?.data?.message || e.message) });
  }
});

module.exports = router;
