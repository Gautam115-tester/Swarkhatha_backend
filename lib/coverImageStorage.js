const sharp = require('sharp');
const supabase = require('./supabaseClient');
const { decrypt } = require('./crypto');
const drime = require('./drime');

// Cover art is only ever JPEG/PNG/WebP in practice (embedded audio tags or
// an admin picking a photo) — GIF/TIFF/VIPS are never a legitimate input
// here. Blocking those loaders outright removes that native-parsing attack
// surface entirely (see GHSA-f88m-g3jw-g9cj, July 2026 — high-severity
// libvips bugs specifically in these three loaders, fixed in sharp
// 0.35.0+). Carried over unchanged from the old lib/imageStorage.js.
sharp.block({ operation: ['VipsForeignLoadNsgif', 'VipsForeignLoadTiff', 'VipsForeignLoadVips'] });

// Cover art arrives as whatever's embedded in the source audio file's own
// tags (see admin's metadata_extractor.dart) — no size/dimension guarantee
// at all. Re-encoding to a capped JPEG here, once, at upload time, means
// the bloat never enters storage in the first place. Unchanged from the
// old Supabase-backed version.
const MAX_DIMENSION_PX = 1000;
const JPEG_QUALITY = 82;

/* ------------------------------------------------------------------
 * Cover images now live on a dedicated Drime account instead of
 * Supabase Storage — see migration_image_storage_drime.sql. This picks
 * whichever active 'image'-purpose account has the most free space,
 * the same auto-pick logic routes/storage.js already used for
 * music/audio_story uploads. Deliberately does NOT fall back to a
 * 'both' account: 'both' means "music & audio_story" and the public,
 * unauthenticated cover proxy route (GET /api/storage/cover/:accountId/
 * :hash — see routes/storage.js) relies on "this account's purpose is
 * exactly 'image'" as its whole authorization check, so mixing gated
 * audio into an image-purpose account (or vice versa) would be a
 * confidentiality bug, not just a labeling one.
 * ------------------------------------------------------------------ */
async function pickImageAccount() {
  const { data: accounts, error } = await supabase
    .from('storage_accounts').select('*').eq('is_active', true).eq('purpose', 'image');
  if (error) throw new Error('Could not look up image storage accounts: ' + error.message);
  if (!accounts || accounts.length === 0) {
    throw new Error(
      "No 'image' Drime storage account configured. Add one from the admin app's " +
      "Storage screen (\"Add account\" → purpose \"Cover images\"), or run " +
      'scripts/migrate-cover-images-to-drime.js with --token to create one.'
    );
  }
  return accounts.sort((a, b) => (b.last_known_free_bytes ?? 0) - (a.last_known_free_bytes ?? 0))[0];
}

// prefix is 'album' | 'story' — kept only as a hint baked into the
// filename for readability in the Drime dashboard; nothing reads it back.
async function uploadImage({ buffer, prefix, accountId }) {
  const resized = await sharp(buffer)
    .rotate() // apply any EXIF orientation before stripping metadata
    .resize({
      width: MAX_DIMENSION_PX,
      height: MAX_DIMENSION_PX,
      fit: 'inside',
      withoutEnlargement: true
    })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer();

  let account;
  if (accountId) {
    const { data } = await supabase.from('storage_accounts').select('*').eq('id', accountId).single();
    if (!data) throw new Error('Storage account not found');
    if (data.purpose !== 'image') throw new Error(`Account "${data.label}" is not purpose 'image'`);
    account = data;
  } else {
    account = await pickImageAccount();
  }

  const creds = JSON.parse(decrypt(account.credentials_enc));
  const fileName = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  const uploaded = await drime.uploadFile({
    accessToken: creds.accessToken,
    buffer: resized,
    fileName,
    mime: 'image/jpeg',
    workspaceId: creds.workspaceId,
    folderId: creds.folderId
  });

  return {
    accountId: account.id,
    storageFileId: uploaded.fileEntryId,
    storageHash: uploaded.hash,
    fileName: uploaded.fileName,
    sizeBytes: uploaded.fileSizeBytes || resized.length
  };
}

module.exports = { uploadImage };
