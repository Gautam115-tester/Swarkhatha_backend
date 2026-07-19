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

// email+password login against a registered MediaFire "Application".
//
// CORRECTED: user/get_session_token.php always requires BOTH
// application_id and signature — MediaFire's own Core API docs list
// both under "Required Parameters" with no unsigned/appId-less mode,
// and error 128 ("Required parameters for this request are missing")
// is exactly what comes back when either is absent. There is no
// email+password-only path. signature is SHA1(email + password +
// application_id + api_key); api_key only has to be a real value if
// the Application's MediaFire dashboard has "require secret key"
// turned on — otherwise it's fine as an empty string in the hash, but
// application_id itself is never optional.
//
// So the per-account appId/apiKey params are only for letting one
// account use a DIFFERENT MediaFire Application than the rest of the
// pool. When they're left blank (the normal case), fall back to a
// single Application registered once at
// https://www.mediafire.com/developers/ and configured via
// MEDIAFIRE_APP_ID / MEDIAFIRE_API_KEY below.
//
// token_version is deliberately left at MediaFire's default (1) rather
// than requested as 2: a v2 token demands a signature on every
// subsequent call, but getAccountInfo/uploadFile/getStreamLink/
// getDownloadLink/deleteFile below never send one — requesting v2
// would just break all of those right after login succeeds.
async function getSessionToken({ email, password, appId, apiKey }) {
  const resolvedAppId = (appId && appId.trim()) || process.env.MEDIAFIRE_APP_ID;
  const resolvedApiKey = (apiKey && apiKey.trim()) || process.env.MEDIAFIRE_API_KEY || '';

  if (!resolvedAppId) {
    throw new Error(
      "No MediaFire application_id available. Either supply an App ID for this account, " +
      "or set MEDIAFIRE_APP_ID (register one free at https://www.mediafire.com/developers/) " +
      "in the backend's environment."
    );
  }

  const signature = crypto
    .createHash('sha1')
    .update(`${email}${password}${resolvedAppId}${resolvedApiKey}`)
    .digest('hex');

  const params = new URLSearchParams({
    email,
    password,
    application_id: resolvedAppId,
    signature,
    response_format: 'json'
  });

  const resp = await axios.post(`${BASE}/user/get_session_token.php`, params);
  const result = resp.data.response;
  if (result.result !== 'Success') {
    throw new Error(result.message || 'MediaFire login failed');
  }
  return { sessionToken: result.session_token, ekey: result.ekey, pkey: result.pkey };
}

// Storage + bandwidth in one call. MediaFire's `bandwidth` field on
// user/get_info is the account's REMAINING direct-download bandwidth
// balance for premium accounts (premium accounts get 1TB/month, see
// https://mediafire.zendesk.com/hc/en-us/articles/207100597). Free
// accounts don't have a personal bandwidth balance — they draw from
// MediaFire's shared 50GB/day direct_download pool instead (that
// number only comes back from file/get_links, per-request, since it's
// not tied to any one account). So for free accounts we report
// bandwidth as "shared" rather than a per-account number.
async function getAccountInfo({ sessionToken }) {
  const resp = await axios.get(`${BASE}/user/get_info.php`, {
    params: { session_token: sessionToken, response_format: 'json' }
  });
  const info = resp.data.response.user_info;
  const isPremium = info.premium === 'yes';
  return {
    usedBytes: Number(info.used_storage_size || 0),
    limitBytes: Number(info.storage_limit || 0),
    isPremium,
    // Only meaningful for premium accounts; null for free accounts
    // (they share the global pool — see getStreamLink's freeBandwidthMB).
    bandwidthRemainingBytes: isPremium ? Number(info.bandwidth || 0) : null,
    bandwidthTotalBytes: isPremium ? 1024 * 1024 * 1024 * 1024 : null // 1TB/month, MediaFire premium standard
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

// Returns a playable direct_download URL. Works on every MediaFire account
// (free included) — it's not paid-gated, but free accounts share a 50 GB/day
// bandwidth pool for it (see freeBandwidthMB below); paid accounts can keep
// going past that on their own bandwidth. Throws if MediaFire can't issue
// one right now (e.g. that day's free pool is exhausted) — there's no
// usable fallback link type: normal_download is a web page, not audio
// bytes, so it can't play in a player either.
async function getStreamLink({ sessionToken, quickKey }) {
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
  if (!link) {
    throw new Error('MediaFire could not issue a direct playable link right now (the free 50GB/day direct-download bandwidth may be exhausted for today) — try again later');
  }
  return {
    url: link,
    // MB of this account's shared free direct_download bandwidth left today
    freeBandwidthMB: result.direct_download_free_bandwidth !== undefined
      ? Number(result.direct_download_free_bandwidth) : null
  };
}

// Returns a real, fetchable file URL for saving offline — MediaFire only
// exposes raw bytes via the direct_download link type (same one streaming
// uses; there's no separate "download" link type at the API level).
// normal_download is a mediafire.com/file/... WEB PAGE with an ad-gated
// button, not a byte stream, so it's not usable for an automated download —
// this throws instead of silently handing back an unusable page URL.
async function getDownloadLink({ sessionToken, quickKey }) {
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
  if (!link) {
    throw new Error('MediaFire could not issue a direct file link right now (the free 50GB/day direct-download bandwidth may be exhausted for today) — try again later');
  }
  return {
    url: link,
    fileName: null,
    freeBandwidthMB: result.direct_download_free_bandwidth !== undefined
      ? Number(result.direct_download_free_bandwidth) : null
  };
}

async function deleteFile({ sessionToken, quickKey }) {
  const resp = await axios.get(`${BASE}/file/delete.php`, {
    params: { session_token: sessionToken, quick_key: quickKey, response_format: 'json' }
  });
  return resp.data.response;
}

module.exports = { getSessionToken, getAccountInfo, uploadFile, getStreamLink, getDownloadLink, deleteFile };
