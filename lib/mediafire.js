const axios = require('axios');
const crypto = require('crypto');

/**
 * Minimal MediaFire API client.
 * Docs: https://www.mediafire.com/developers/core_api/1.5/getting_started/
 *
 * NOTE ON STREAMING: MediaFire's `direct_download` link type (the only
 * kind that's actually playable as a raw audio URL) requires the
 * MediaFire account to be on a paid plan. On a free account,
 * getStreamLink() below will fall back to the normal file/view page URL,
 * which is NOT directly playable by an <audio> tag — it's an HTML page.
 * If you plan to lean on MediaFire for playback (not just storage), the
 * account added here should be a paid MediaFire account.
 */

const BASE = 'https://www.mediafire.com/api/1.5';

// email+password login. If apiKey is supplied, a signature is computed
// per MediaFire's token_version=2 signing scheme; otherwise an
// unsigned (token_version=1) request is used, which MediaFire still
// accepts for basic email/password apps.
async function getSessionToken({ email, password, appId, apiKey }) {
  const params = new URLSearchParams({
    email,
    password,
    application_id: appId || '',
    response_format: 'json'
  });

  if (apiKey) {
    const signature = crypto
      .createHash('sha1')
      .update(`${email}${password}${appId}${apiKey}`)
      .digest('hex');
    params.set('signature', signature);
    params.set('token_version', '2');
  }

  const resp = await axios.post(`${BASE}/user/get_session_token.php`, params);
  const result = resp.data.response;
  if (result.result !== 'Success') {
    throw new Error(result.message || 'MediaFire login failed');
  }
  return { sessionToken: result.session_token, ekey: result.ekey, pkey: result.pkey };
}

async function getAccountInfo({ sessionToken }) {
  const resp = await axios.get(`${BASE}/user/get_info.php`, {
    params: { session_token: sessionToken, response_format: 'json' }
  });
  const info = resp.data.response.user_info;
  return {
    usedBytes: Number(info.used_storage_size || 0),
    limitBytes: Number(info.storage_limit || 0)
  };
}

// MediaFire's "simple upload" accepts the raw file body (not multipart),
// with the filename passed as a query/header param.
async function uploadFile({ sessionToken, buffer, fileName, folderKey }) {
  const params = {
    session_token: sessionToken,
    response_format: 'json',
    filename: fileName
  };
  if (folderKey) params.folder_key = folderKey;

  const resp = await axios.post(`${BASE}/upload/simple.php`, buffer, {
    params,
    headers: {
      'Content-Type': 'application/octet-stream',
      'x-filename': fileName
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  });

  const result = resp.data.response;
  if (result.result !== 'Success' && !result.doupload) {
    throw new Error(result.message || 'MediaFire upload failed');
  }

  const uploadKey = result.doupload.key;

  // Poll until MediaFire finishes processing the upload server-side.
  let status;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const pollResp = await axios.get(`${BASE}/upload/poll_upload.php`, {
      params: { key: uploadKey, response_format: 'json' }
    });
    status = pollResp.data.response.doupload;
    if (status.result === '0' && status.status === '99') break; // done
    if (status.result !== '0') throw new Error('MediaFire upload failed during processing');
  }

  return { quickKey: status.quickkey, fileName };
}

// Returns the best playable URL we can get. direct_download works on every
// MediaFire account (free included) — it's not paid-gated, but free
// accounts share a 50 GB/day bandwidth pool for it (see freeBandwidthMB
// below); paid accounts can keep going past that on their own bandwidth.
// Falls back to the normal view-page URL only if direct_download itself
// errors out (e.g. that day's free bandwidth pool is exhausted).
async function getStreamLink({ sessionToken, quickKey }) {
  try {
    const resp = await axios.get(`${BASE}/file/get_links.php`, {
      params: {
        session_token: sessionToken,
        quick_key: quickKey,
        link_type: 'direct_download',
        response_format: 'json'
      }
    });
    const result = resp.data.response;
    const link = result.links?.[0]?.direct_download;
    if (link) {
      return {
        url: link,
        direct: true,
        // MB of this account's shared free direct_download bandwidth left today
        freeBandwidthMB: result.direct_download_free_bandwidth !== undefined
          ? Number(result.direct_download_free_bandwidth) : null
      };
    }
  } catch (_) { /* fall through to normal link */ }

  const resp = await axios.get(`${BASE}/file/get_links.php`, {
    params: { session_token: sessionToken, quick_key: quickKey, response_format: 'json' }
  });
  const normalLink = resp.data.response.links?.[0]?.normal_download;
  return { url: normalLink, direct: false, freeBandwidthMB: null };
}

// Returns a normal_download link — MediaFire's file-download page, which
// works on every account (free or paid) and triggers a real file download
// in a browser/webview, unlike direct_download (paid-only, meant for
// inline <audio> playback via getStreamLink above).
async function getDownloadLink({ sessionToken, quickKey }) {
  const resp = await axios.get(`${BASE}/file/get_links.php`, {
    params: { session_token: sessionToken, quick_key: quickKey, response_format: 'json' }
  });
  const link = resp.data.response.links?.[0];
  if (!link || !link.normal_download) {
    throw new Error('MediaFire did not return a download link for this file');
  }
  return { url: link.normal_download, fileName: link.filename };
}

async function deleteFile({ sessionToken, quickKey }) {
  const resp = await axios.get(`${BASE}/file/delete.php`, {
    params: { session_token: sessionToken, quick_key: quickKey, response_format: 'json' }
  });
  return resp.data.response;
}

module.exports = { getSessionToken, getAccountInfo, uploadFile, getStreamLink, getDownloadLink, deleteFile };
