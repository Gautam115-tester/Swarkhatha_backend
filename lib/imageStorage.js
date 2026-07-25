const sharp = require('sharp');
const supabase = require('./supabaseClient');

// All cover images (album art + audio-story covers) live in this one
// public Supabase Storage bucket, split into prefixes ("album/",
// "story/") purely for readability in the Supabase dashboard — nothing
// in the app relies on the prefix.
const BUCKET = process.env.SUPABASE_IMAGES_BUCKET || 'cover-images';

let bucketReady = false;

// Buckets aren't in schema.sql (that's Postgres tables only — Storage
// buckets are a separate Supabase subsystem with no SQL migration
// path), so this lazily creates it on first use instead of requiring
// a manual dashboard step. Safe to call on every request — the create
// call only actually hits the network once per server process.
async function ensureBucket() {
  if (bucketReady) return;
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) throw new Error('Could not list Supabase storage buckets: ' + error.message);

  if (!buckets.some((b) => b.name === BUCKET)) {
    const { error: createErr } = await supabase.storage.createBucket(BUCKET, {
      public: true,
      fileSizeLimit: 10 * 1024 * 1024 // 10MB per image
    });
    // Ignore a race where another request created it a moment earlier.
    if (createErr && !/already exists/i.test(createErr.message)) {
      throw new Error('Could not create Supabase storage bucket: ' + createErr.message);
    }
  }
  bucketReady = true;
}

// Cover art arrives as whatever's embedded in the source audio file's own
// tags (see admin's metadata_extractor.dart) — no size/dimension guarantee
// at all. Some FLAC/hi-res rips embed multi-megabyte, multi-thousand-pixel
// art that's wildly oversized for anything this app renders it at (largest
// on-screen use is the full-width player page in artwork_lyrics_pager.dart,
// which never needs more than ~1000px on the long edge even on the highest-
// DPI phones). Every one of those bytes is paid for twice: once to store,
// and again on *every* fetch — cached or not — from Supabase's Storage CDN.
// Re-encoding to a capped JPEG here, once, at upload time, means the bloat
// never enters the bucket in the first place, regardless of what any
// client does or doesn't cache.
const MAX_DIMENSION_PX = 1000;
const JPEG_QUALITY = 82;

// One year: safe because each upload gets a fresh, unique path below and
// files are never overwritten in place (upsert: false), so a cached copy
// can never go stale under a path that's still being served.
const CACHE_CONTROL_SECONDS = '31536000';

// prefix is 'album' | 'story' — see BUCKET comment above.
async function uploadImage({ buffer, prefix }) {
  await ensureBucket();

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

  const path = `${prefix}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;

  const { error } = await supabase.storage.from(BUCKET).upload(path, resized, {
    contentType: 'image/jpeg',
    cacheControl: CACHE_CONTROL_SECONDS,
    upsert: false
  });
  if (error) throw new Error('Supabase image upload failed: ' + error.message);

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

module.exports = { uploadImage, BUCKET };
