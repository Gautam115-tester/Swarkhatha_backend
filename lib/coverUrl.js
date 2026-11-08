'use strict';

// Single source of truth for the public URL of a cover image. Previously this
// lived only inside routes/storage.js; routes/media.js now needs it too because
// artwork is uploaded server-side (see lib/artwork.js), not by a separate client call.
//
// When IMAGE_CDN_BASE_URL is set, covers are served from the CDN; otherwise from
// this backend's own public GET /api/storage/cover/:accountId/:hash route.
function coverBaseUrl(req) {
  return (
    process.env.IMAGE_CDN_BASE_URL ||
    process.env.BASE_URL ||
    `${req.protocol}://${req.get('host')}`
  );
}

function coverUrl(req, { accountId, storageHash }) {
  return `${coverBaseUrl(req)}/api/storage/cover/${accountId}/${storageHash}`;
}

module.exports = { coverBaseUrl, coverUrl };
