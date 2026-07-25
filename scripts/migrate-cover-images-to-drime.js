#!/usr/bin/env node
/**
 * One-off migration: move every cover image (album art + audio-story
 * covers) off Supabase Storage and onto a dedicated, 'image'-purpose
 * Drime account — see migration_image_storage_drime.sql for the schema
 * side of this and lib/coverImageStorage.js / routes/storage.js for how
 * new uploads and serving work going forward.
 *
 * Run this AFTER applying supabase/migration_image_storage_drime.sql.
 *
 * USAGE
 *   cd backend
 *   npm install   # if you haven't already
 *
 *   # Register a brand new Drime account as the image account, then migrate:
 *   node scripts/migrate-cover-images-to-drime.js --token=<drime_access_token> [--label="Drime - Cover Images"]
 *
 *   # Or reuse an account you already connected from the admin app's
 *   # Storage screen (purpose must be "Cover images"):
 *   node scripts/migrate-cover-images-to-drime.js --account-id=<uuid>
 *
 *   # See what would happen without changing anything:
 *   node scripts/migrate-cover-images-to-drime.js --token=... --dry-run
 *
 *   # After you've spot-checked the app and covers look right, free up
 *   # the Supabase bucket by deleting the originals it copied from:
 *   node scripts/migrate-cover-images-to-drime.js --token=... --delete-source
 *
 * Needs the same env vars the backend itself uses (SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY, TOKEN_ENC_KEY, BASE_URL) — run it from the
 * backend/ folder so `require('dotenv').config()` picks up your .env,
 * or export them in the shell first (e.g. before running as a one-off
 * Render Shell job).
 *
 * Safe to re-run: any album/story_series/media_items row whose
 * cover_image_url already points at this backend's own
 * /api/storage/cover/ proxy is skipped, so an interrupted run (or a
 * later run to pick up newly-added covers) just picks up where it left
 * off.
 */

require('dotenv').config();
const axios = require('axios');
const supabase = require('../lib/supabaseClient');
const { encrypt, decrypt } = require('../lib/crypto');
const drime = require('../lib/drime');

const BUCKET = process.env.SUPABASE_IMAGES_BUCKET || 'cover-images';

function parseArgs(argv) {
  const args = { deleteSource: false, dryRun: false };
  for (const raw of argv) {
    if (raw === '--delete-source') args.deleteSource = true;
    else if (raw === '--dry-run') args.dryRun = true;
    else if (raw.startsWith('--token=')) args.token = raw.slice('--token='.length);
    else if (raw.startsWith('--account-id=')) args.accountId = raw.slice('--account-id='.length);
    else if (raw.startsWith('--label=')) args.label = raw.slice('--label='.length);
    else if (raw.startsWith('--workspace-id=')) args.workspaceId = Number(raw.slice('--workspace-id='.length));
    else if (raw.startsWith('--folder-id=')) args.folderId = raw.slice('--folder-id='.length);
  }
  return args;
}

function baseUrl() {
  const url = process.env.BASE_URL;
  if (!url || /your-backend\.onrender\.com/.test(url)) {
    throw new Error(
      'BASE_URL is not set to your real deployed backend URL (found: ' + (url || '(empty)') + '). ' +
      'The migrated cover_image_url values are built from BASE_URL, so this must be correct ' +
      'BEFORE migrating, or every app screen will fail to load images.'
    );
  }
  return url.replace(/\/$/, '');
}

/* ------------------------------------------------------------------
 * Resolve which storage_accounts row (purpose='image') to migrate
 * into — either a freshly-registered one (--token) or an existing one
 * an admin already added from the Storage screen (--account-id).
 * ------------------------------------------------------------------ */
async function resolveImageAccount(args) {
  if (args.accountId) {
    const { data: account, error } = await supabase.from('storage_accounts').select('*').eq('id', args.accountId).single();
    if (error || !account) throw new Error(`No storage_accounts row found for --account-id=${args.accountId}`);
    if (account.purpose !== 'image') {
      throw new Error(`Account "${account.label}" has purpose '${account.purpose}', not 'image'. ` +
        `Re-tag it to "Cover images" from the admin app's Storage screen first.`);
    }
    console.log(`Using existing image account: ${account.label} (${account.id})`);
    return account;
  }

  if (!args.token) {
    throw new Error('Pass either --token=<drime_access_token> (to connect a new account) or --account-id=<uuid> (to reuse one already connected).');
  }

  console.log('Checking the Drime token (cli/loggedUser)...');
  const user = await drime.getLoggedUser({ accessToken: args.token });
  console.log(`Token OK — belongs to ${user.email || user.display_name || 'this Drime account'}.`);

  console.log('Checking available storage (user/space-usage)...');
  const usage = await drime.getSpaceUsage({ accessToken: args.token });
  console.log(`Free space: ${(usage.availableBytes / 1e9).toFixed(2)} GB of ${(usage.limitBytes / 1e9).toFixed(2)} GB.`);

  if (args.dryRun) {
    console.log('[dry run] Would create a new storage_accounts row here (purpose: image). Skipping insert.');
    return {
      id: '00000000-0000-0000-0000-000000000000',
      label: args.label || `Drime - ${user.email || 'Cover Images'}`,
      credentials_enc: encrypt(JSON.stringify({ accessToken: args.token, workspaceId: args.workspaceId ?? 0, folderId: args.folderId ?? null })),
      purpose: 'image'
    };
  }

  const creds = { accessToken: args.token, workspaceId: args.workspaceId ?? 0, folderId: args.folderId ?? null };
  const { data: account, error } = await supabase.from('storage_accounts').insert({
    provider: 'drime',
    label: args.label || `Drime - Cover Images (${user.email || user.display_name || 'account'})`,
    purpose: 'image',
    credentials_enc: encrypt(JSON.stringify(creds)),
    last_known_free_bytes: usage.availableBytes,
    last_known_used_bytes: usage.usedBytes,
    last_known_total_bytes: usage.limitBytes,
    last_checked_at: new Date().toISOString()
  }).select().single();
  if (error) throw new Error('Failed to save the new storage account: ' + error.message);

  console.log(`Connected and saved as a new storage account: ${account.label} (${account.id}).`);
  console.log(`It'll show up in the admin app's Storage screen immediately (purpose: Cover images).`);
  return account;
}

// Supabase public-bucket URLs look like:
//   https://<project>.supabase.co/storage/v1/object/public/<bucket>/<path>
// Returns just <path>, or null if this doesn't look like one of ours
// (e.g. it's already been migrated, or is some other external URL).
function supabasePathFromUrl(url) {
  if (!url) return null;
  const marker = `/storage/v1/object/public/${BUCKET}/`;
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  return url.slice(idx + marker.length);
}

function alreadyMigrated(url, base) {
  return typeof url === 'string' && url.startsWith(`${base}/api/storage/cover/`);
}

async function downloadImage(url) {
  const resp = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(resp.data);
}

/* ------------------------------------------------------------------
 * Migrates one cover image (already-resized bytes from Supabase — no
 * need to run it back through sharp) to the target Drime account and
 * returns the new proxy URL + bookkeeping fields.
 * ------------------------------------------------------------------ */
async function migrateOneImage({ oldUrl, account, base, dryRun }) {
  const path = supabasePathFromUrl(oldUrl);
  const buffer = await downloadImage(oldUrl);

  if (dryRun) {
    return { newUrl: `${base}/api/storage/cover/${account.id}/DRY-RUN-HASH`, storageFileId: null, storageHash: null, sizeBytes: buffer.length, sourcePath: path };
  }

  const creds = JSON.parse(decrypt(account.credentials_enc));
  const fileName = path ? path.split('/').pop() : `cover-${Date.now()}.jpg`;
  const uploaded = await drime.uploadFile({
    accessToken: creds.accessToken,
    buffer,
    fileName,
    mime: 'image/jpeg',
    workspaceId: creds.workspaceId,
    folderId: creds.folderId
  });

  return {
    newUrl: `${base}/api/storage/cover/${account.id}/${uploaded.hash}`,
    storageFileId: uploaded.fileEntryId,
    storageHash: uploaded.hash,
    sizeBytes: uploaded.fileSizeBytes || buffer.length,
    sourcePath: path
  };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const base = baseUrl();
  const account = await resolveImageAccount(args);

  const summary = { migrated: 0, skippedAlready: 0, errors: [], bytesMovedTotal: 0, sourcePathsToDelete: [] };

  // ---- Albums ----
  const { data: albums, error: albumsErr } = await supabase.from('albums').select('*');
  if (albumsErr) throw new Error('Failed to load albums: ' + albumsErr.message);

  for (const album of albums || []) {
    if (!album.cover_image_url) continue;
    if (alreadyMigrated(album.cover_image_url, base)) { summary.skippedAlready++; continue; }

    console.log(`Album "${album.name}": migrating cover...`);
    try {
      const result = await migrateOneImage({ oldUrl: album.cover_image_url, account, base, dryRun: args.dryRun });
      summary.migrated++;
      summary.bytesMovedTotal += result.sizeBytes;
      if (result.sourcePath) summary.sourcePathsToDelete.push(result.sourcePath);

      if (!args.dryRun) {
        const { error: updErr } = await supabase.from('albums').update({
          cover_image_url: result.newUrl,
          image_storage_account_id: account.id,
          image_storage_file_id: result.storageFileId,
          image_storage_hash: result.storageHash
        }).eq('id', album.id);
        if (updErr) throw new Error('DB update failed: ' + updErr.message);

        const { error: cascadeErr } = await supabase.from('media_items')
          .update({ cover_image_url: result.newUrl }).eq('album_id', album.id);
        if (cascadeErr) throw new Error('Cascading to media_items failed: ' + cascadeErr.message);
      }
      console.log(`  -> ${result.newUrl}${args.dryRun ? '  [dry run — nothing written]' : ''}`);
    } catch (e) {
      console.error(`  FAILED: ${e.message}`);
      summary.errors.push({ type: 'album', id: album.id, name: album.name, error: e.message });
    }
  }

  // ---- Story series ----
  const { data: series, error: seriesErr } = await supabase.from('story_series').select('*');
  if (seriesErr) throw new Error('Failed to load story_series: ' + seriesErr.message);

  for (const s of series || []) {
    if (!s.cover_image_url) continue;
    if (alreadyMigrated(s.cover_image_url, base)) { summary.skippedAlready++; continue; }

    console.log(`Story "${s.title}": migrating cover...`);
    try {
      const result = await migrateOneImage({ oldUrl: s.cover_image_url, account, base, dryRun: args.dryRun });
      summary.migrated++;
      summary.bytesMovedTotal += result.sizeBytes;
      if (result.sourcePath) summary.sourcePathsToDelete.push(result.sourcePath);

      if (!args.dryRun) {
        const { error: updErr } = await supabase.from('story_series').update({
          cover_image_url: result.newUrl,
          image_storage_account_id: account.id,
          image_storage_file_id: result.storageFileId,
          image_storage_hash: result.storageHash
        }).eq('id', s.id);
        if (updErr) throw new Error('DB update failed: ' + updErr.message);

        const { error: cascadeErr } = await supabase.from('media_items')
          .update({ cover_image_url: result.newUrl }).eq('story_series_id', s.id);
        if (cascadeErr) throw new Error('Cascading to media_items failed: ' + cascadeErr.message);
      }
      console.log(`  -> ${result.newUrl}${args.dryRun ? '  [dry run — nothing written]' : ''}`);
    } catch (e) {
      console.error(`  FAILED: ${e.message}`);
      summary.errors.push({ type: 'story_series', id: s.id, name: s.title, error: e.message });
    }
  }

  // ---- Orphan media_items (a cover_image_url with no album_id/story_series_id
  //      to inherit from — legacy rows, if any) ----
  const { data: orphans, error: orphansErr } = await supabase
    .from('media_items').select('*').is('album_id', null).is('story_series_id', null).not('cover_image_url', 'is', null);
  if (orphansErr) throw new Error('Failed to load orphan media_items: ' + orphansErr.message);

  for (const item of orphans || []) {
    if (alreadyMigrated(item.cover_image_url, base)) { summary.skippedAlready++; continue; }

    console.log(`Track "${item.title}" (no album/series): migrating cover...`);
    try {
      const result = await migrateOneImage({ oldUrl: item.cover_image_url, account, base, dryRun: args.dryRun });
      summary.migrated++;
      summary.bytesMovedTotal += result.sizeBytes;
      if (result.sourcePath) summary.sourcePathsToDelete.push(result.sourcePath);

      if (!args.dryRun) {
        const { error: updErr } = await supabase.from('media_items').update({ cover_image_url: result.newUrl }).eq('id', item.id);
        if (updErr) throw new Error('DB update failed: ' + updErr.message);
      }
      console.log(`  -> ${result.newUrl}${args.dryRun ? '  [dry run — nothing written]' : ''}`);
    } catch (e) {
      console.error(`  FAILED: ${e.message}`);
      summary.errors.push({ type: 'media_item', id: item.id, name: item.title, error: e.message });
    }
  }

  // ---- Optionally delete the now-migrated Supabase originals ----
  if (args.deleteSource && !args.dryRun && summary.sourcePathsToDelete.length > 0) {
    console.log(`Deleting ${summary.sourcePathsToDelete.length} original file(s) from Supabase bucket "${BUCKET}"...`);
    const { error: delErr } = await supabase.storage.from(BUCKET).remove(summary.sourcePathsToDelete);
    if (delErr) console.error('  Some/all deletions failed (originals left in place): ' + delErr.message);
    else console.log('  Done.');
  } else if (args.deleteSource && args.dryRun) {
    console.log(`[dry run] Would delete ${summary.sourcePathsToDelete.length} original file(s) from Supabase bucket "${BUCKET}".`);
  }

  console.log('\n---- Summary ----');
  console.log(`Migrated:        ${summary.migrated}`);
  console.log(`Already done:    ${summary.skippedAlready}`);
  console.log(`Bytes moved:     ${(summary.bytesMovedTotal / 1e6).toFixed(2)} MB`);
  console.log(`Errors:          ${summary.errors.length}`);
  if (summary.errors.length) {
    for (const e of summary.errors) console.log(`  - [${e.type}] ${e.name} (${e.id}): ${e.error}`);
  }
  if (args.dryRun) console.log('\n(dry run — no database or storage changes were made)');

  process.exit(summary.errors.length > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error('Migration aborted: ' + e.message);
  process.exit(1);
});
