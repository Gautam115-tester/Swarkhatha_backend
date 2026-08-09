#!/usr/bin/env node
/**
 * One-off maintenance: find already-uploaded covers that are bigger than
 * they need to be, re-run them through the SAME resize/compress pipeline
 * coverImageStorage.js already applies to every new upload
 * (lib/coverImageStorage.js — 1000px max dimension, JPEG quality 82,
 * plus the same sharp.block() hardening), re-point the DB row at the
 * smaller result, and delete the old file from Drime.
 *
 * WHY THIS IS NEEDED EVEN THOUGH EVERY UPLOAD PATH ALREADY RESIZES:
 * every cover — old or new — should already have gone through some
 * version of this same resize step at its original upload time (either
 * today's coverImageStorage.js, or the old pre-Drime lib/imageStorage.js
 * that migrate-cover-images-to-drime.js assumed when it copied bytes
 * across as-is without reprocessing). So this script isn't fixing a
 * systematic gap — it's a safety net for outliers: rows that somehow
 * never went through that pipeline (a bulk import, a manual DB edit, an
 * interrupted migration), or genuinely complex/detailed images that
 * legitimately encoded larger even at the same quality setting. Run
 * this once, check the summary, and it's done — this is not something
 * that needs to run regularly, since every upload since
 * coverImageStorage.js existed already produces small output.
 *
 * TRUE REPLACEMENT (delete the old Drime file), and its one real limit:
 * albums/story_series store their cover's Drime fileEntryId in
 * image_storage_file_id (see supabase/migration_image_storage_drime.sql
 * and findOrCreateAlbum/findOrCreateStorySeries in routes/media.js) —
 * when that's present on a row, this script deletes the OLD file right
 * after the new one is safely uploaded and the row repointed, so
 * nothing is left orphaned. It's still best-effort: a delete failure is
 * logged, never thrown, since the new cover is already live and correct
 * either way. The one case this can't clean up is a row that predates
 * that column existing (image_storage_file_id still null) — those get
 * recompressed and repointed exactly the same, but the very first old
 * file for that particular row is left behind since there's no
 * lookup-by-hash endpoint to recover its id after the fact (see
 * lib/drime.js's exports). Every row this script touches gets its
 * identifiers backfilled either way, so that's a one-time gap per row,
 * not a recurring one — if you run this script again later, or the
 * cover gets replaced again through the app, that later deletion will
 * work normally. media_items rows with their own cover (no album/series
 * to inherit from) don't have image_storage_* columns at all, so old
 * files for those specifically can never be auto-deleted this way — see
 * the orphan loop below.
 *
 * USAGE
 *   cd backend
 *   node scripts/recompress-large-covers.js --dry-run
 *   node scripts/recompress-large-covers.js --threshold-kb=200
 *
 * Needs the same env vars the backend itself uses (SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY, TOKEN_ENC_KEY) — run from backend/ so
 * dotenv picks up .env, or export them first.
 */

require('dotenv').config();
const axios = require('axios');
const supabase = require('../lib/supabaseClient');
const coverImageStorage = require('../lib/coverImageStorage');

function parseArgs(argv) {
  const args = { dryRun: false, thresholdBytes: 200 * 1024 }; // 200KB default — matches the admin app's own client-side skip threshold, see lib/utils/cover_compressor.dart
  for (const raw of argv) {
    if (raw === '--dry-run') args.dryRun = true;
    else if (raw.startsWith('--threshold-kb=')) args.thresholdBytes = Number(raw.slice('--threshold-kb='.length)) * 1024;
  }
  return args;
}

// Matches .../api/storage/cover/:accountId/:hash regardless of what
// precedes it (BASE_URL or IMAGE_CDN_BASE_URL — covers may be pointing
// at either depending on when repoint-cover-urls-to-cdn.js last ran).
const COVER_URL_RE = /\/api\/storage\/cover\/([^/]+)\/([^/?]+)/;

function parseCoverUrl(url) {
  const m = typeof url === 'string' ? url.match(COVER_URL_RE) : null;
  return m ? { accountId: m[1], hash: m[2] } : null;
}

function coverBaseUrl() {
  return (process.env.IMAGE_CDN_BASE_URL || process.env.BASE_URL || '').replace(/\/$/, '');
}

async function downloadCurrent(url) {
  const resp = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(resp.data);
}

/**
 * Checks one cover's current size and, if it's above the threshold,
 * re-runs it through coverImageStorage.uploadImage() — the exact same
 * function every live upload already calls — then best-effort deletes
 * the row's previous file if we know its fileEntryId
 * (oldStorageAccountId/oldStorageFileId, from image_storage_account_id/
 * image_storage_file_id — null for rows that predate those columns).
 * Returns null if it was already small enough to leave alone.
 */
async function maybeRecompress({ url, prefix, thresholdBytes, dryRun, oldStorageAccountId, oldStorageFileId }) {
  const parsed = parseCoverUrl(url);
  if (!parsed) return null; // not one of our own cover URLs — leave it alone

  const buffer = await downloadCurrent(url);
  if (buffer.length <= thresholdBytes) return null; // already small enough

  if (dryRun) {
    return { oldBytes: buffer.length, newBytes: null, newUrl: null };
  }

  const uploaded = await coverImageStorage.uploadImage({ buffer, prefix, accountId: parsed.accountId });
  const newUrl = `${coverBaseUrl()}/api/storage/cover/${uploaded.accountId}/${uploaded.storageHash}`;

  if (oldStorageAccountId && oldStorageFileId) {
    try {
      await coverImageStorage.deleteImage({ accountId: oldStorageAccountId, storageFileId: oldStorageFileId });
    } catch (e) {
      console.error(`    (old file left on Drime — delete failed: ${e.response?.data?.message || e.message})`);
    }
  }

  return {
    oldBytes: buffer.length, newBytes: uploaded.sizeBytes, newUrl,
    newAccountId: uploaded.accountId, newStorageFileId: uploaded.storageFileId, newStorageHash: uploaded.storageHash
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!coverBaseUrl()) {
    throw new Error('Neither IMAGE_CDN_BASE_URL nor BASE_URL is set — new cover URLs would be malformed. Set one before running.');
  }

  console.log(`Threshold: re-compressing anything over ${(args.thresholdBytes / 1024).toFixed(0)}KB.${args.dryRun ? ' (dry run — nothing will be written)' : ''}\n`);

  const summary = { checked: 0, recompressed: 0, alreadySmall: 0, oldFilesDeleted: 0, oldFilesOrphaned: 0, errors: [], bytesBefore: 0, bytesAfter: 0 };

  // ---- Albums ----
  const { data: albums, error: albumsErr } = await supabase.from('albums').select('*');
  if (albumsErr) throw new Error('Failed to load albums: ' + albumsErr.message);

  for (const album of albums || []) {
    if (!album.cover_image_url) continue;
    summary.checked++;
    try {
      const result = await maybeRecompress({
        url: album.cover_image_url, prefix: 'album', thresholdBytes: args.thresholdBytes, dryRun: args.dryRun,
        oldStorageAccountId: album.image_storage_account_id, oldStorageFileId: album.image_storage_file_id
      });
      if (!result) { summary.alreadySmall++; continue; }

      summary.recompressed++;
      summary.bytesBefore += result.oldBytes;
      if (!args.dryRun) {
        summary.bytesAfter += result.newBytes;
        (album.image_storage_account_id && album.image_storage_file_id) ? summary.oldFilesDeleted++ : summary.oldFilesOrphaned++;
        const { error: updErr } = await supabase.from('albums').update({
          cover_image_url: result.newUrl,
          image_storage_account_id: result.newAccountId,
          image_storage_file_id: result.newStorageFileId,
          image_storage_hash: result.newStorageHash
        }).eq('id', album.id);
        if (updErr) throw new Error('DB update failed: ' + updErr.message);
        const { error: cascadeErr } = await supabase.from('media_items').update({ cover_image_url: result.newUrl }).eq('album_id', album.id);
        if (cascadeErr) throw new Error('Cascading to media_items failed: ' + cascadeErr.message);
        console.log(`Album "${album.name}": ${(result.oldBytes / 1024).toFixed(0)}KB -> ${(result.newBytes / 1024).toFixed(0)}KB`);
      } else {
        console.log(`Album "${album.name}": ${(result.oldBytes / 1024).toFixed(0)}KB -> [dry run, not recompressed]`);
      }
    } catch (e) {
      console.error(`  FAILED (album "${album.name}"): ${e.message}`);
      summary.errors.push({ type: 'album', id: album.id, name: album.name, error: e.message });
    }
  }

  // ---- Story series ----
  const { data: series, error: seriesErr } = await supabase.from('story_series').select('*');
  if (seriesErr) throw new Error('Failed to load story_series: ' + seriesErr.message);

  for (const s of series || []) {
    if (!s.cover_image_url) continue;
    summary.checked++;
    try {
      const result = await maybeRecompress({
        url: s.cover_image_url, prefix: 'story', thresholdBytes: args.thresholdBytes, dryRun: args.dryRun,
        oldStorageAccountId: s.image_storage_account_id, oldStorageFileId: s.image_storage_file_id
      });
      if (!result) { summary.alreadySmall++; continue; }

      summary.recompressed++;
      summary.bytesBefore += result.oldBytes;
      if (!args.dryRun) {
        summary.bytesAfter += result.newBytes;
        (s.image_storage_account_id && s.image_storage_file_id) ? summary.oldFilesDeleted++ : summary.oldFilesOrphaned++;
        const { error: updErr } = await supabase.from('story_series').update({
          cover_image_url: result.newUrl,
          image_storage_account_id: result.newAccountId,
          image_storage_file_id: result.newStorageFileId,
          image_storage_hash: result.newStorageHash
        }).eq('id', s.id);
        if (updErr) throw new Error('DB update failed: ' + updErr.message);
        const { error: cascadeErr } = await supabase.from('media_items').update({ cover_image_url: result.newUrl }).eq('story_series_id', s.id);
        if (cascadeErr) throw new Error('Cascading to media_items failed: ' + cascadeErr.message);
        console.log(`Story "${s.title}": ${(result.oldBytes / 1024).toFixed(0)}KB -> ${(result.newBytes / 1024).toFixed(0)}KB`);
      } else {
        console.log(`Story "${s.title}": ${(result.oldBytes / 1024).toFixed(0)}KB -> [dry run, not recompressed]`);
      }
    } catch (e) {
      console.error(`  FAILED (story "${s.title}"): ${e.message}`);
      summary.errors.push({ type: 'story_series', id: s.id, name: s.title, error: e.message });
    }
  }

  // ---- Orphan media_items (own cover, no album/series to inherit from —
  // this table has no image_storage_* columns, so the old file for
  // these specifically can never be auto-deleted; see header comment) ----
  const { data: orphans, error: orphansErr } = await supabase
    .from('media_items').select('*').is('album_id', null).is('story_series_id', null).not('cover_image_url', 'is', null);
  if (orphansErr) throw new Error('Failed to load orphan media_items: ' + orphansErr.message);

  for (const item of orphans || []) {
    summary.checked++;
    try {
      const result = await maybeRecompress({ url: item.cover_image_url, prefix: item.type === 'audio_story' ? 'story' : 'album', thresholdBytes: args.thresholdBytes, dryRun: args.dryRun });
      if (!result) { summary.alreadySmall++; continue; }

      summary.recompressed++;
      summary.bytesBefore += result.oldBytes;
      if (!args.dryRun) {
        summary.bytesAfter += result.newBytes;
        summary.oldFilesOrphaned++; // media_items has no image_storage_* columns — see header comment
        const { error: updErr } = await supabase.from('media_items').update({ cover_image_url: result.newUrl }).eq('id', item.id);
        if (updErr) throw new Error('DB update failed: ' + updErr.message);
        console.log(`Track "${item.title}": ${(result.oldBytes / 1024).toFixed(0)}KB -> ${(result.newBytes / 1024).toFixed(0)}KB`);
      } else {
        console.log(`Track "${item.title}": ${(result.oldBytes / 1024).toFixed(0)}KB -> [dry run, not recompressed]`);
      }
    } catch (e) {
      console.error(`  FAILED (track "${item.title}"): ${e.message}`);
      summary.errors.push({ type: 'media_item', id: item.id, name: item.title, error: e.message });
    }
  }

  console.log('\n--- Summary ---');
  console.log(`Checked:            ${summary.checked}`);
  console.log(`Already small:      ${summary.alreadySmall}`);
  console.log(`Recompressed:       ${summary.recompressed}`);
  if (!args.dryRun) {
    console.log(`Old files deleted:  ${summary.oldFilesDeleted}`);
    console.log(`Old files orphaned: ${summary.oldFilesOrphaned} (no fileEntryId on record for these — see header comment)`);
  }
  if (summary.recompressed > 0 && !args.dryRun) {
    const savedKb = (summary.bytesBefore - summary.bytesAfter) / 1024;
    const pct = ((1 - summary.bytesAfter / summary.bytesBefore) * 100).toFixed(0);
    console.log(`Total saved:        ${savedKb.toFixed(0)}KB (${pct}% smaller across recompressed covers)`);
  }
  if (summary.errors.length) {
    console.log(`Errors:             ${summary.errors.length}`);
    for (const e of summary.errors) console.log(`  - ${e.type} ${e.id} (${e.name}): ${e.error}`);
  }
  if (args.dryRun) console.log('\nThis was a dry run — nothing was written. Re-run without --dry-run to apply.');
}

main().catch((e) => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});