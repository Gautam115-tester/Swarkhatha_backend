const express = require('express');
const multer = require('multer');
const supabase = require('../lib/supabaseClient');
const { encrypt, decrypt } = require('../lib/crypto');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const b2 = require('../lib/backblaze');
const mediafire = require('../lib/mediafire');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 1024 } }); // 1GB cap

const PROVIDERS = ['backblaze', 'mediafire'];
const PURPOSES = ['music', 'audio_story', 'both'];

function loadCreds(account) {
  return JSON.parse(decrypt(account.credentials_enc));
}

/* ------------------------------------------------------------------
 * 1) ADD A STORAGE ACCOUNT  (admin only)
 *    Backblaze body: { provider:'backblaze', keyId, applicationKey, bucketId, bucketName, purpose, label }
 *    MediaFire body:  { provider:'mediafire', email, password, appId, apiKey, folderKey, purpose, label }
 * ------------------------------------------------------------------ */
router.post('/accounts', requireAuth, requireAdmin, async (req, res) => {
  const { provider, purpose = 'both', label } = req.body;
  if (!PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: `provider must be one of ${PROVIDERS.join(', ')}` });
  }
  if (!PURPOSES.includes(purpose)) {
    return res.status(400).json({ error: `purpose must be one of ${PURPOSES.join(', ')}` });
  }

  try {
    if (provider === 'backblaze') {
      const { keyId, applicationKey, bucketId, bucketName } = req.body;
      if (!keyId || !applicationKey || !bucketId || !bucketName) {
        return res.status(400).json({ error: 'keyId, applicationKey, bucketId, bucketName are required for backblaze' });
      }
      // verify the credentials work before saving
      const info = await b2.authorize({ keyId, applicationKey });

      const creds = { keyId, applicationKey, bucketId, bucketName };
      const { data: row, error } = await supabase.from('storage_accounts').insert({
        provider,
        label: label || `Backblaze - ${bucketName}`,
        purpose,
        credentials_enc: encrypt(JSON.stringify(creds)),
        external_account_id: info.accountId,
        last_checked_at: new Date().toISOString()
      }).select().single();
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ account: { id: row.id, label: row.label, provider, purpose: row.purpose } });
    }

    if (provider === 'mediafire') {
      const { email, password, appId, apiKey, folderKey } = req.body;
      if (!email || !password) {
        return res.status(400).json({ error: 'email and password are required for mediafire' });
      }
      const session = await mediafire.getSessionToken({ email, password, appId, apiKey });
      const info = await mediafire.getAccountInfo({ sessionToken: session.sessionToken });

      const creds = { email, password, appId, apiKey, folderKey };
      const { data: row, error } = await supabase.from('storage_accounts').insert({
        provider,
        label: label || `MediaFire - ${email}`,
        purpose,
        credentials_enc: encrypt(JSON.stringify(creds)),
        last_known_free_bytes: info.limitBytes - info.usedBytes,
        last_checked_at: new Date().toISOString()
      }).select().single();
      if (error) return res.status(500).json({ error: error.message });
      return res.json({
        account: { id: row.id, label: row.label, provider, purpose: row.purpose },
        note: 'Streaming from MediaFire requires a paid MediaFire account for direct_download links; free accounts will get a view-page link instead.'
      });
    }
  } catch (e) {
    return res.status(500).json({ error: `${provider} account setup failed: ` + (e.response?.data?.message || e.response?.data?.response?.message || e.message) });
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

      if (acct.provider === 'backblaze') {
        // B2 is pay-as-you-go (no fixed quota), so "free space" is tracked
        // ourselves as an admin-set allocation minus what we've uploaded.
        const { data: sumRows } = await supabase
          .from('media_items')
          .select('file_size_bytes')
          .eq('storage_account_id', acct.id);
        const usedBytes = (sumRows || []).reduce((s, r) => s + (r.file_size_bytes || 0), 0);
        const allocatedBytes = acct.allocated_bytes || null;
        const freeBytes = allocatedBytes ? Math.max(allocatedBytes - usedBytes, 0) : null;

        return {
          id: acct.id, label: acct.label, provider: acct.provider, purpose: acct.purpose,
          usedBytes, allocatedBytes, freeBytes,
          freeGB: freeBytes !== null ? (freeBytes / 1e9).toFixed(2) : 'unlimited (pay-as-you-go)',
          status: 'ok'
        };
      }

      if (acct.provider === 'mediafire') {
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
      }
    } catch (e) {
      return { id: acct.id, label: acct.label, provider: acct.provider, purpose: acct.purpose, status: 'error', error: e.message };
    }
  }));

  res.json({ accounts: results.sort((a, b) => (b.freeBytes || Infinity) - (a.freeBytes || Infinity)) });
});

// Admin: rename/re-tag an account, or (backblaze only) set a manual space allocation
router.patch('/accounts/:id', requireAuth, requireAdmin, async (req, res) => {
  const { purpose, label, allocatedBytes } = req.body;
  if (purpose && !PURPOSES.includes(purpose)) {
    return res.status(400).json({ error: `purpose must be one of ${PURPOSES.join(', ')}` });
  }
  const update = {};
  if (purpose) update.purpose = purpose;
  if (label) update.label = label;
  if (allocatedBytes !== undefined) update.allocated_bytes = allocatedBytes;
  if (Object.keys(update).length === 0) return res.status(400).json({ error: 'Nothing to update' });

  const { data, error } = await supabase.from('storage_accounts').update(update).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ account: data });
});

/* ------------------------------------------------------------------
 * 3) UPLOAD  (admin picks provider+account, or omits accountId to
 *    auto-pick the best-fitting account of the given provider — or,
 *    if provider is also omitted, the best across BOTH providers)
 * ------------------------------------------------------------------ */
router.post('/upload', requireAuth, requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  const { accountId, provider, folder = 'SwarKatha', mediaType } = req.body;
  const requiredBytes = req.file.size;

  if (!mediaType || !['music', 'audio_story'].includes(mediaType)) {
    return res.status(400).json({ error: "mediaType is required and must be 'music' or 'audio_story'" });
  }
  if (provider && !PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: `provider must be one of ${PROVIDERS.join(', ')}` });
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
    let q = supabase.from('storage_accounts').select('*').eq('is_active', true).in('purpose', [mediaType, 'both']);
    if (provider) q = q.eq('provider', provider);
    const { data: accounts } = await q;
    if (!accounts || accounts.length === 0) {
      return res.status(507).json({ error: `No matching '${mediaType}' (or 'both') storage account found${provider ? ` for provider '${provider}'` : ''}` });
    }
    // Simple heuristic: prefer accounts with more last_known_free_bytes; B2
    // accounts with no allocation set are treated as always-fits.
    account = accounts.sort((a, b) => (b.last_known_free_bytes ?? Infinity) - (a.last_known_free_bytes ?? Infinity))[0];
  }

  try {
    const creds = loadCreds(account);

    if (account.provider === 'backblaze') {
      const auth = await b2.authorize({ keyId: creds.keyId, applicationKey: creds.applicationKey });
      const uploadUrlInfo = await b2.getUploadUrl({ apiUrl: auth.apiUrl, authorizationToken: auth.authorizationToken, bucketId: creds.bucketId });
      const fileName = `${folder}/${req.file.originalname}`;
      const uploaded = await b2.uploadFile({
        uploadUrl: uploadUrlInfo.uploadUrl,
        uploadAuthToken: uploadUrlInfo.authorizationToken,
        fileName,
        buffer: req.file.buffer,
        contentType: req.file.mimetype
      });

      return res.json({
        accountId: account.id,
        accountLabel: account.label,
        provider: 'backblaze',
        storageFileId: uploaded.fileId,
        storagePath: fileName,
        sizeBytes: uploaded.contentLength || requiredBytes
      });
    }

    if (account.provider === 'mediafire') {
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
    }

    return res.status(400).json({ error: `Unsupported provider '${account.provider}'` });
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

    if (account.provider === 'backblaze') {
      const auth = await b2.authorize({ keyId: creds.keyId, applicationKey: creds.applicationKey });
      // Assumes the bucket is private; if it's public, this token is harmless extra info.
      const token = await b2.getDownloadAuthorization({
        apiUrl: auth.apiUrl,
        authorizationToken: auth.authorizationToken,
        bucketId: creds.bucketId,
        fileNamePrefix: item.storage_path,
        validDurationInSeconds: 3600
      });
      const url = `${b2.buildFileUrl({ downloadUrl: auth.downloadUrl, bucketName: creds.bucketName, fileName: item.storage_path })}?Authorization=${token}`;
      return res.json({ url, expiresInSeconds: 3600, provider: 'backblaze' });
    }

    if (account.provider === 'mediafire') {
      const session = await mediafire.getSessionToken({ email: creds.email, password: creds.password, appId: creds.appId, apiKey: creds.apiKey });
      const link = await mediafire.getStreamLink({ sessionToken: session.sessionToken, quickKey: item.storage_file_id });
      return res.json({
        url: link.url,
        direct: link.direct,
        provider: 'mediafire',
        note: link.direct ? undefined : 'This is a MediaFire view-page link, not a direct playable stream (requires a paid MediaFire account for direct_download).'
      });
    }

    res.status(400).json({ error: `Unsupported provider '${account.provider}'` });
  } catch (e) {
    res.status(500).json({ error: 'Failed to resolve stream link: ' + (e.response?.data?.message || e.message) });
  }
});

module.exports = router;
