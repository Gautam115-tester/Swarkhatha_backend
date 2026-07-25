#!/usr/bin/env node
/**
 * One-off cleanup: delete everything from the old Supabase Storage
 * cover-images bucket, now that migrate-cover-images-to-drime.js has
 * already run for real and every album/story_series/media_items row
 * points at the new Drime-backed /api/storage/cover/:accountId/:hash
 * proxy instead.
 *
 * Why not just re-run migrate-cover-images-to-drime.js --delete-source?
 * That script only ever queues a source path for deletion at the
 * moment it *freshly* migrates a row. Once a row's cover_image_url has
 * already been overwritten with the new Drime URL (which yours have),
 * alreadyMigrated() makes it skip that row entirely on any later run —
 * so the original Supabase path is gone from the database and
 * --delete-source has nothing left to act on. This script instead
 * empties the bucket directly.
 *
 * SAFETY CHECK (always runs first, even with --apply):
 * Scans albums, story_series, and media_items for any cover_image_url
 * that still points at the Supabase bucket (i.e. didn't get migrated —
 * a row added after your migration run, or one that errored during
 * it). If it finds any, it lists them and stops WITHOUT deleting
 * anything from the bucket, so you don't blow away images something
 * is still using. Re-run scripts/migrate-cover-images-to-drime.js
 * (it's safe to re-run — already-migrated rows are skipped) to pick
 * those up, then run this again.
 *
 * USAGE
 *   cd backend
 *   node scripts/purge-supabase-covers.js            # dry run (default) — lists what would be deleted
 *   node scripts/purge-supabase-covers.js --apply    # actually empties the bucket
 *
 * Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (same as the other
 * scripts) — run from backend/ so dotenv picks up your .env.
 */

require('dotenv').config();
const supabase = require('../lib/supabaseClient');

const BUCKET = process.env.SUPABASE_IMAGES_BUCKET || 'cover-images';

function parseArgs(argv) {
  return { apply: argv.includes('--apply') };
}

function pointsAtSupabaseBucket(url) {
  return typeof url === 'string' && url.includes(`/storage/v1/object/public/${BUCKET}/`);
}

/* ------------------------------------------------------------------
 * Confirms nothing in the database still references the bucket
 * we're about to empty. Returns an array of { table, id, name, url }
 * for any offending rows (empty array = safe to proceed).
 * ------------------------------------------------------------------ */
async function findRemainingReferences() {
  const offenders = [];

  const { data: albums, error: albumsErr } = await supabase.from('albums').select('id, name, cover_image_url');
  if (albumsErr) throw new Error('Failed to check albums: ' + albumsErr.message);
  for (const a of albums || []) {
    if (pointsAtSupabaseBucket(a.cover_image_url)) offenders.push({ table: 'albums', id: a.id, name: a.name, url: a.cover_image_url });
  }

  const { data: series, error: seriesErr } = await supabase.from('story_series').select('id, title, cover_image_url');
  if (seriesErr) throw new Error('Failed to check story_series: ' + seriesErr.message);
  for (const s of series || []) {
    if (pointsAtSupabaseBucket(s.cover_image_url)) offenders.push({ table: 'story_series', id: s.id, name: s.title, url: s.cover_image_url });
  }

  const { data: items, error: itemsErr } = await supabase.from('media_items').select('id, title, cover_image_url');
  if (itemsErr) throw new Error('Failed to check media_items: ' + itemsErr.message);
  for (const i of items || []) {
    if (pointsAtSupabaseBucket(i.cover_image_url)) offenders.push({ table: 'media_items', id: i.id, name: i.title, url: i.cover_image_url });
  }

  return offenders;
}

/* ------------------------------------------------------------------
 * Recursively lists every file path in the bucket. Supabase Storage's
 * list() is not recursive and returns folders as entries with a null
 * id/metadata, so we walk into those ourselves.
 * ------------------------------------------------------------------ */
async function listAllFiles(prefix = '') {
  const paths = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const { data: entries, error } = await supabase.storage.from(BUCKET).list(prefix, { limit, offset });
    if (error) throw new Error(`Failed to list "${prefix}": ${error.message}`);
    if (!entries || entries.length === 0) break;

    for (const entry of entries) {
      const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const isFolder = entry.id === null && !entry.metadata;
      if (isFolder) {
        paths.push(...(await listAllFiles(fullPath)));
      } else {
        paths.push({ path: fullPath, sizeBytes: entry.metadata?.size ?? 0 });
      }
    }

    if (entries.length < limit) break;
    offset += limit;
  }

  return paths;
}

async function run() {
  const { apply } = parseArgs(process.argv.slice(2));

  console.log(`Checking the database for anything still pointing at the "${BUCKET}" bucket...`);
  const offenders = await findRemainingReferences();
  if (offenders.length > 0) {
    console.log(`\nFound ${offenders.length} row(s) still referencing Supabase Storage — stopping WITHOUT touching the bucket:\n`);
    for (const o of offenders) console.log(`  [${o.table}] "${o.name}" (${o.id}): ${o.url}`);
    console.log('\nRe-run scripts/migrate-cover-images-to-drime.js (safe to re-run) to migrate these, then run this script again.');
    process.exit(1);
  }
  console.log('None found — every cover_image_url in the database already points at Drime.\n');

  console.log(`Listing files in bucket "${BUCKET}"...`);
  const files = await listAllFiles();
  const totalBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0);

  if (files.length === 0) {
    console.log('Bucket is already empty. Nothing to do.');
    process.exit(0);
  }

  console.log(`Found ${files.length} file(s), ${(totalBytes / 1e6).toFixed(2)} MB total.`);
  if (!apply) {
    console.log('\n[dry run] Sample of files that would be deleted:');
    for (const f of files.slice(0, 15)) console.log(`  - ${f.path}`);
    if (files.length > 15) console.log(`  ...and ${files.length - 15} more.`);
    console.log('\n(dry run — nothing deleted; re-run with --apply to actually empty the bucket)');
    process.exit(0);
  }

  console.log('\nDeleting...');
  const CHUNK_SIZE = 100;
  let deleted = 0;
  const errors = [];
  for (let i = 0; i < files.length; i += CHUNK_SIZE) {
    const chunk = files.slice(i, i + CHUNK_SIZE).map((f) => f.path);
    const { error } = await supabase.storage.from(BUCKET).remove(chunk);
    if (error) errors.push(error.message);
    else deleted += chunk.length;
  }

  console.log('\n---- Summary ----');
  console.log(`Deleted:  ${deleted} / ${files.length} file(s)`);
  console.log(`Freed:    ~${(totalBytes / 1e6).toFixed(2)} MB`);
  console.log(`Errors:   ${errors.length}`);
  if (errors.length) errors.forEach((e) => console.log(`  - ${e}`));

  process.exit(errors.length > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error('Purge aborted: ' + e.message);
  process.exit(1);
});
