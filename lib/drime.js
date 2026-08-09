const axios = require('axios');
const http = require('http');
const https = require('https');

// Every call in this file goes to the same Drime API host, and with
// millions of cover images across thousands of users this backend can be
// making many Drime requests per second. Without keep-alive, axios/Node
// opens a brand new TCP + TLS connection for every single one of those —
// on a free-tier Render instance that handshake overhead is a real,
// entirely avoidable chunk of the latency users feel as "the image is
// slow". A shared, keep-alive client reuses sockets across requests
// instead.
const keepAliveClient = axios.create({
  httpAgent: new http.Agent({ keepAlive: true, maxSockets: 50 }),
  httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 50 })
});

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
  const resp = await keepAliveClient.get(`${BASE}/cli/loggedUser`, { headers: authHeaders(accessToken) });
  return resp.data.user || resp.data;
}

// Storage used/available for this Drime account, used for the
// space-aware auto-pick-an-account logic and the live storage
// dashboard (same role MediaFire's user/get_info played before).
async function getSpaceUsage({ accessToken }) {
  const resp = await keepAliveClient.get(`${BASE}/user/space-usage`, { headers: authHeaders(accessToken) });
  const usedBytes = Number(resp.data.used || 0);
  const availableBytes = Number(resp.data.available || 0);
  return { usedBytes, availableBytes, limitBytes: usedBytes + availableBytes };
}

// Just the presign step, split out so routes/storage.js can hand the
// signed URL straight to the client instead of PUTting the buffer
// itself (see presignSimpleUpload/registerEntry below — this is what
// upload-init/upload-complete use for direct-from-device uploads).
async function presignSimpleUpload({ accessToken, fileName, mime, size, workspaceId }) {
  const headers = authHeaders(accessToken);
  const presign = await keepAliveClient.post(`${BASE}/s3/simple/presign`, {
    filename: fileName,
    mime: mime || 'application/octet-stream',
    size,
    extension: extensionOf(fileName),
    workspaceId: workspaceId ?? 0
  }, { headers });
  return presign.data; // { url, key }
}

// The final "register what's now sitting in storage as a real file
// entry" step, shared by both the simple and multipart paths (and by
// uploadFile() below for the still-server-side cover-image path).
async function registerEntry({ accessToken, key, size, fileName, mime, workspaceId, folderId }) {
  const headers = authHeaders(accessToken);
  const uuidFilename = key.split('/').pop();
  const entry = await keepAliveClient.post(`${BASE}/s3/entries`, {
    filename: uuidFilename,
    size,
    clientName: fileName,
    clientMime: mime || 'application/octet-stream',
    clientExtension: extensionOf(fileName),
    workspaceId: workspaceId ?? 0,
    parentId: folderId ?? null
  }, { headers });
  return entry.data.fileEntry;
}

// < 5MB: presigned single PUT straight to S3/R2, then register the
// entry. "More performant" per Drime's own upload guide since the file
// bytes go straight to storage rather than through an extra hop.
// (Still used server-side by uploadFile() below, for cover images,
// which need to be resized/re-encoded on this server before storage —
// see lib/coverImageStorage.js. Music/audio_story uploads no longer
// call this; they use presignSimpleUpload + registerEntry directly
// from routes/storage.js so the PUT happens from the admin's device.)
async function simpleUpload({ accessToken, buffer, fileName, mime, workspaceId, folderId }) {
  const { url, key } = await presignSimpleUpload({ accessToken, fileName, mime, size: buffer.length, workspaceId });

  await keepAliveClient.put(url, buffer, {
    headers: { 'Content-Type': mime || 'application/octet-stream' },
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  });

  return registerEntry({ accessToken, key, size: buffer.length, fileName, mime, workspaceId, folderId });
}

// Granular multipart steps, split out (same reasoning as
// presignSimpleUpload/registerEntry above) so routes/storage.js can
// hand the signed part URLs to the admin's device and let IT do the
// chunked PUTs, instead of pulling the whole file into this server's
// memory and re-uploading it.
async function createMultipartUpload({ accessToken, fileName, mime, size, workspaceId, folderId }) {
  const headers = authHeaders(accessToken);
  const create = await keepAliveClient.post(`${BASE}/s3/multipart/create`, {
    filename: fileName,
    mime: mime || 'application/octet-stream',
    size,
    extension: extensionOf(fileName),
    parentId: folderId ?? null,
    workspaceId: workspaceId ?? 0
  }, { headers });
  return create.data; // { uploadId, key }
}

async function batchSignPartUrls({ accessToken, uploadId, key, partNumbers }) {
  const headers = authHeaders(accessToken);
  const signed = await keepAliveClient.post(`${BASE}/s3/multipart/batch-sign-part-urls`, {
    uploadId, key, partNumbers
  }, { headers });
  return signed.data.urls; // [{ partNumber, url }]
}

async function completeMultipartUpload({ accessToken, uploadId, key, parts }) {
  const headers = authHeaders(accessToken);
  await keepAliveClient.post(`${BASE}/s3/multipart/complete`, { uploadId, key, parts }, { headers });
}

async function abortMultipartUpload({ accessToken, uploadId, key }) {
  const headers = authHeaders(accessToken);
  try {
    await keepAliveClient.post(`${BASE}/s3/multipart/abort`, { uploadId, key }, { headers });
  } catch (_) {
    // best-effort cleanup only — caller surfaces the original error
  }
}

// >= 5MB: create a multipart upload, get one presigned PUT url per
// chunk, upload each chunk and keep its ETag, then complete. Aborts the
// upload server-side on any failure so Drime doesn't accumulate orphaned
// in-progress multipart uploads against the account's storage.
// (Still used server-side by uploadFile() below for anything that goes
// through it — in practice only cover images today, which are always
// well under the 5MB simple-upload threshold, so this path is mostly
// dead weight for images but kept for correctness/future-proofing.
// Music/audio_story uploads use the granular functions above directly
// from routes/storage.js instead.)
async function multipartUpload({ accessToken, buffer, fileName, mime, workspaceId, folderId }) {
  const size = buffer.length;
  const { uploadId, key } = await createMultipartUpload({ accessToken, fileName, mime, size, workspaceId, folderId });

  const totalParts = Math.max(1, Math.ceil(size / MULTIPART_CHUNK_BYTES));
  const partNumbers = Array.from({ length: totalParts }, (_, i) => i + 1);

  try {
    const signedUrls = await batchSignPartUrls({ accessToken, uploadId, key, partNumbers });
    const urlByPart = new Map(signedUrls.map((u) => [u.partNumber, u.url]));

    const parts = [];
    for (const partNumber of partNumbers) {
      const start = (partNumber - 1) * MULTIPART_CHUNK_BYTES;
      const end = Math.min(start + MULTIPART_CHUNK_BYTES, size);
      const chunk = buffer.subarray(start, end);
      const partUrl = urlByPart.get(partNumber);
      if (!partUrl) throw new Error(`Drime did not return a signed URL for part ${partNumber}`);

      const putResp = await keepAliveClient.put(partUrl, chunk, {
        headers: { 'Content-Type': mime || 'application/octet-stream' },
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      });
      const etag = putResp.headers.etag || putResp.headers.ETag;
      if (!etag) throw new Error(`Drime/S3 did not return an ETag for part ${partNumber}`);
      parts.push({ ETag: etag, PartNumber: partNumber });
    }

    await completeMultipartUpload({ accessToken, uploadId, key, parts });
    return registerEntry({ accessToken, key, size, fileName, mime, workspaceId, folderId });
  } catch (e) {
    await abortMultipartUpload({ accessToken, uploadId, key });
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
  return keepAliveClient.get(`${BASE}/file-entries/download/${hash}`, {
    headers,
    responseType: 'stream',
    validateStatus: (status) => status < 500
  });
}

// Buffered (non-streaming) download, for small files that are safe to
// hold fully in memory and worth caching — i.e. cover images, never
// audio. Unlike getFileStream() above, this has no Range support (a
// cover image is never scrubbed/seeked, so there's nothing to forward),
// which keeps the response cacheable as a single whole object instead of
// a set of byte-range fragments. See lib/coverImageCache.js for the cache
// this feeds.
async function getFileBuffer({ accessToken, hash }) {
  const resp = await keepAliveClient.get(`${BASE}/file-entries/download/${hash}`, {
    headers: authHeaders(accessToken),
    responseType: 'arraybuffer',
    validateStatus: (status) => status < 500
  });
  if (resp.status >= 400) {
    const err = new Error(`Drime returned ${resp.status} for file ${hash}`);
    err.status = resp.status;
    throw err;
  }
  return {
    buffer: Buffer.from(resp.data),
    contentType: resp.headers['content-type'] || 'application/octet-stream'
  };
}

// Lists file entries in a workspace (optionally scoped to one folder) —
// GET /drive/file-entries, Laravel-style pagination (page param in,
// current_page/data/total/last_page-shaped response out). Used by
// one-off cleanup scripts (see scripts/cleanup-orphaned-covers.js) that
// need to reconcile what's actually sitting on Drime against what the
// database still references, rather than by any live request path —
// nothing else in this codebase needs to browse a folder's contents.
async function listEntries({ accessToken, workspaceId, folderId, page = 1 }) {
  const params = { workspaceId: workspaceId ?? 0, page };
  if (folderId) params.parentId = folderId;
  const resp = await keepAliveClient.get(`${BASE}/drive/file-entries`, { headers: authHeaders(accessToken), params });
  return resp.data; // { data: [...], current_page, total, last_page? }
}

// Drime's delete endpoint is POST /file-entries/delete (NOT a DELETE verb
// on /file-entries, despite that being the more RESTful shape you'd
// expect) — see https://docs.drime.cloud/api-reference/files/delete-entries.
// deleteForever: true skips trash and removes the file immediately, which
// is what we want here since these are orphaned covers, not something a
// user might want to recover.
async function deleteFile({ accessToken, fileEntryId }) {
  const resp = await keepAliveClient.post(`${BASE}/file-entries/delete`, {
    entryIds: [String(fileEntryId)],
    deleteForever: true
  }, { headers: authHeaders(accessToken) });
  return resp.data;
}

module.exports = {
  getLoggedUser, getSpaceUsage, uploadFile, getFileStream, getFileBuffer, deleteFile, listEntries,
  // Granular steps for direct-from-device uploads (see routes/storage.js
  // POST /upload-init and /upload-complete) — the actual file bytes PUT
  // straight from the admin app to Drime/S3, never touching this server.
  presignSimpleUpload, registerEntry,
  createMultipartUpload, batchSignPartUrls, completeMultipartUpload, abortMultipartUpload,
  SIMPLE_UPLOAD_MAX_BYTES, MULTIPART_CHUNK_BYTES
};