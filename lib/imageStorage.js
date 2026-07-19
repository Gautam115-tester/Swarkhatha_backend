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

const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif'
};

// prefix is 'album' | 'story' — see BUCKET comment above.
async function uploadImage({ buffer, mime, prefix }) {
  await ensureBucket();
  const ext = EXT_BY_MIME[mime] || 'jpg';
  const path = `${prefix}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  const { error } = await supabase.storage.from(BUCKET).upload(path, buffer, {
    contentType: mime || 'image/jpeg',
    upsert: false
  });
  if (error) throw new Error('Supabase image upload failed: ' + error.message);

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

module.exports = { uploadImage, BUCKET };
