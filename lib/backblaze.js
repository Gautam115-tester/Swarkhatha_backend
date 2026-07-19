const axios = require('axios');
const crypto = require('crypto');

/**
 * Minimal Backblaze B2 native-API client (no aws-sdk dependency —
 * B2's own API is simpler and avoids S3-compat quirks).
 * Docs: https://www.backblaze.com/apidocs/introduction-to-the-b2-native-api
 */

async function authorize({ keyId, applicationKey }) {
  const auth = Buffer.from(`${keyId}:${applicationKey}`).toString('base64');
  const resp = await axios.get('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
    headers: { Authorization: `Basic ${auth}` }
  });
  return resp.data; // { apiUrl, downloadUrl, authorizationToken, accountId, allowed: { bucketId, bucketName } }
}

async function getUploadUrl({ apiUrl, authorizationToken, bucketId }) {
  const resp = await axios.post(
    `${apiUrl}/b2api/v2/b2_get_upload_url`,
    { bucketId },
    { headers: { Authorization: authorizationToken } }
  );
  return resp.data; // { uploadUrl, authorizationToken }
}

async function uploadFile({ uploadUrl, uploadAuthToken, fileName, buffer, contentType }) {
  const sha1 = crypto.createHash('sha1').update(buffer).digest('hex');
  const resp = await axios.post(uploadUrl, buffer, {
    headers: {
      Authorization: uploadAuthToken,
      'X-Bz-File-Name': encodeURIComponent(fileName),
      'Content-Type': contentType || 'b2/x-auto',
      'X-Bz-Content-Sha1': sha1,
      'Content-Length': buffer.length
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  });
  return resp.data; // { fileId, fileName, contentLength, ... }
}

// For private buckets: mints a short-lived token that can be appended
// as ?Authorization=<token> to a download URL so the app never needs
// the account's master key.
async function getDownloadAuthorization({ apiUrl, authorizationToken, bucketId, fileNamePrefix, validDurationInSeconds = 3600 }) {
  const resp = await axios.post(
    `${apiUrl}/b2api/v2/b2_get_download_authorization`,
    { bucketId, fileNamePrefix, validDurationInSeconds },
    { headers: { Authorization: authorizationToken } }
  );
  return resp.data.authorizationToken;
}

function buildFileUrl({ downloadUrl, bucketName, fileName }) {
  return `${downloadUrl}/file/${bucketName}/${encodeURIComponent(fileName).replace(/%2F/g, '/')}`;
}

async function getAccountInfo(creds) {
  // B2 has no fixed storage quota (it's pay-as-you-go),
  // so we surface accountId/bucket info and let usage tracking happen in our
  // own DB (sum of file_size_bytes uploaded to this account).
  const info = await authorize(creds);
  return info;
}

async function deleteFile({ apiUrl, authorizationToken, fileId, fileName }) {
  const resp = await axios.post(
    `${apiUrl}/b2api/v2/b2_delete_file_version`,
    { fileId, fileName },
    { headers: { Authorization: authorizationToken } }
  );
  return resp.data;
}

module.exports = {
  authorize,
  getUploadUrl,
  uploadFile,
  getDownloadAuthorization,
  buildFileUrl,
  getAccountInfo,
  deleteFile
};
