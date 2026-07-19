const axios = require('axios');

/**
 * Minimal Drime Cloud API client.
 * Docs: https://docs.drime.cloud/introduction
 *
 * Unlike MediaFire, Drime does NOT use an email/password login dance on
 * every call — an account is authenticated once, up front, by creating a
 * long-lived personal access token from the Drime dashboard
 * (Account Settings -> Developers -> Create a token) and handing that
 * token to this backend. So there is no getSessionToken()/session
 * refresh step here: every call below just sends
 * `Authorization: Bearer <accessToken>`, where accessToken is whatever
 * was stored (encrypted) for that pooled storage_accounts row.
 *
 * NOTE ON STREAMING/DOWNLOAD: Drime's file-bytes endpoint
 * (GET /file-entries/download/{hash}) requires that same Bearer token on
 * every request — there is no "direct, credential-free" link type like
 * MediaFire's direct_download. That means the Drime access token can
 * never be handed to the Flutter app directly. Instead, routes/storage.js
 * proxies playback/downloads: it calls getFileStream() below with the
 * account's token (kept server-side) and pipes the response back to the
 * app through this backend's own /api/storage/stream|file endpoints,
 * which are gated by short-lived signed tokens instead (see
 * middleware/auth.js signMediaToken/requireMediaAccess).
 */

const BASE = process.env.DRIME_API_BASE || 'https://app.drime.cloud/api/v1';

// Drime's own docs recommend the simple presigned-URL flow only for
// files under 5MB; anything at/above that should use the multipart
// flow (create -> batch-sign-part-urls -> PUT each part -> complete).
// Audio files (especially audio-story episodes) frequently exceed 5MB,
// so uploadFile() below picks automatically based on size.
const SIMPLE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
const MULTIPART_CHUNK_BYTES = 10 * 1024 * 1024;

function authHeaders(accessToken) {
  return { Authorization: `Bearer ${accessToken}` };
}

function extensionOf(fileName) {
  const idx = String(fileName || '').lastIndexOf('.');
  return idx >= 0 ? fileName.slice(idx + 1) : '';
}

// Confirms a token is valid and returns who it belongs to. Used when an
// admin connects a new Drime account, so a typo'd/expired token is
// caught immediately instead of surfacing as a confusing upload failure
// later.
async function getLoggedUser({ accessToken }) {
  const resp = await axios.get(`${BASE}/cli/loggedUser`, { headers: authHeaders(accessToken) });
  return resp.data.user || resp.data;
}

// Storage used/available for this Drime account, used for the
// space-aware auto-pick-an-account logic and the live storage
// dashboard (same role MediaFire's user/get_info played before).
async function getSpaceUsage({ accessToken }) {
  const resp = await axios.get(`${BASE}/user/space-usage`, { headers: authHeaders(accessToken) });
  const usedBytes = Number(resp.data.used || 0);
  const availableBytes = Number(resp.data.available || 0);
  return { usedBytes, availableBytes, limitBytes: usedBytes + availableBytes };
}

// < 5MB: presigned single PUT straight to S3/R2, then register the
// entry. "More performant" per Drime's own upload guide since the file
// bytes go straight to storage rather than through an extra hop.
async function simpleUpload({ accessToken, buffer, fileName, mime, workspaceId, folderId }) {
  const headers = authHeaders(accessToken);
  const presign = await axios.post(`${BASE}/s3/simple/presign`, {
    filename: fileName,
    mime: mime || 'application/octet-stream',
    size: buffer.length,
    extension: extensionOf(fileName),
    workspaceId: workspaceId ?? 0
  }, { headers });

  const { url, key } = presign.data;
  await axios.put(url, buffer, {
    headers: { 'Content-Type': mime || 'application/octet-stream' },
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  });

  const uuidFilename = key.split('/').pop();
  const entry = await axios.post(`${BASE}/s3/entries`, {
    filename: uuidFilename,
    size: buffer.length,
    clientName: fileName,
    clientMime: mime || 'application/octet-stream',
    clientExtension: extensionOf(fileName),
    workspaceId: workspaceId ?? 0,
    parentId: folderId ?? null
  }, { headers });

  return entry.data.fileEntry;
}

// >= 5MB: create a multipart upload, get one presigned PUT url per
// chunk, upload each chunk and keep its ETag, then complete. Aborts the
// upload server-side on any failure so Drime doesn't accumulate orphaned
// in-progress multipart uploads against the account's storage.
async function multipartUpload({ accessToken, buffer, fileName, mime, workspaceId, folderId }) {
  const headers = authHeaders(accessToken);
  const size = buffer.length;

  const create = await axios.post(`${BASE}/s3/multipart/create`, {
    filename: fileName,
    mime: mime || 'application/octet-stream',
    size,
    extension: extensionOf(fileName),
    parentId: folderId ?? null,
    workspaceId: workspaceId ?? 0
  }, { headers });
  const { uploadId, key } = create.data;

  const totalParts = Math.max(1, Math.ceil(size / MULTIPART_CHUNK_BYTES));
  const partNumbers = Array.from({ length: totalParts }, (_, i) => i + 1);

  try {
    const signed = await axios.post(`${BASE}/s3/multipart/batch-sign-part-urls`, {
      uploadId, key, partNumbers
    }, { headers });
    const urlByPart = new Map(signed.data.urls.map((u) => [u.partNumber, u.url]));

    const parts = [];
    for (const partNumber of partNumbers) {
      const start = (partNumber - 1) * MULTIPART_CHUNK_BYTES;
      const end = Math.min(start + MULTIPART_CHUNK_BYTES, size);
      const chunk = buffer.subarray(start, end);
      const partUrl = urlByPart.get(partNumber);
      if (!partUrl) throw new Error(`Drime did not return a signed URL for part ${partNumber}`);

      const putResp = await axios.put(partUrl, chunk, {
        headers: { 'Content-Type': mime || 'application/octet-stream' },
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      });
      const etag = putResp.headers.etag || putResp.headers.ETag;
      if (!etag) throw new Error(`Drime/S3 did not return an ETag for part ${partNumber}`);
      parts.push({ ETag: etag, PartNumber: partNumber });
    }

    await axios.post(`${BASE}/s3/multipart/complete`, { uploadId, key, parts }, { headers });

    const uuidFilename = key.split('/').pop();
    const entry = await axios.post(`${BASE}/s3/entries`, {
      filename: uuidFilename,
      size,
      clientName: fileName,
      clientMime: mime || 'application/octet-stream',
      clientExtension: extensionOf(fileName),
      workspaceId: workspaceId ?? 0,
      parentId: folderId ?? null
    }, { headers });

    return entry.data.fileEntry;
  } catch (e) {
    try {
      await axios.post(`${BASE}/s3/multipart/abort`, { uploadId, key }, { headers });
    } catch (_) {
      // best-effort cleanup only — surface the original error below
    }
    throw e;
  }
}

// Picks simple vs multipart based on size and normalizes the result to
// the shape routes/storage.js and routes/media.js expect.
async function uploadFile({ accessToken, buffer, fileName, mime, workspaceId, folderId }) {
  const fileEntry = buffer.length < SIMPLE_UPLOAD_MAX_BYTES
    ? await simpleUpload({ accessToken, buffer, fileName, mime, workspaceId, folderId })
    : await multipartUpload({ accessToken, buffer, fileName, mime, workspaceId, folderId });

  return {
    fileEntryId: String(fileEntry.id),
    hash: fileEntry.hash,
    fileName: fileEntry.name || fileEntry.file_name || fileName,
    fileSizeBytes: Number(fileEntry.file_size || buffer.length)
  };
}

// Streams the raw file bytes back for proxying playback/downloads.
// Forwards Range so audio players can seek/scrub, and passes through
// Drime's response status (200 or 206) + relevant headers untouched.
async function getFileStream({ accessToken, hash, range }) {
  const headers = authHeaders(accessToken);
  if (range) headers.Range = range;
  return axios.get(`${BASE}/file-entries/download/${hash}`, {
    headers,
    responseType: 'stream',
    validateStatus: (status) => status < 500
  });
}

async function deleteFile({ accessToken, fileEntryId }) {
  const resp = await axios.delete(`${BASE}/file-entries`, {
    headers: authHeaders(accessToken),
    data: { entryIds: [String(fileEntryId)], deleteForever: true }
  });
  return resp.data;
}

module.exports = { getLoggedUser, getSpaceUsage, uploadFile, getFileStream, deleteFile };
