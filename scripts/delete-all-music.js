#!/usr/bin/env node
/**
 * One-off cleanup: permanently deletes every `music` media_items row
 * (audio_story rows are never touched), plus:
 *   - the underlying audio file on Drime for each deleted track
 *   - every row in `albums` (music-only — story_series is untouched)
 *   - the underlying cover-image file on Drime for each deleted album
 *   - any play_progress / favorites rows that point at a deleted track
 *     (media_items has no ON DELETE CASCADE from those two tables — see
 *     supabase/schema.sql — so those rows must go first or the delete
 *     of media_items below fails on the foreign key)
 *
 * Story series, story episodes, and their cover images are never
 * touched by this script — only rows with type = 'music' and the
 * `albums` table are in scope.
 *
 * SAFE BY DEFAULT: this runs as a dry run unless you pass --confirm.
 * A dry run reports exactly what it would delete without deleting
 * anything, both on Drime and in the database.
 *
 * USAGE
 *   cd backend
 *   node scripts/delete-all-music.js                # dry run (default)
 *   node scripts/delete-all-music.js --confirm       # actually deletes
 *
 * Needs the same env vars the backend itself uses (SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY, TOKEN_ENC_KEY) — run from backend/ so
 * dotenv picks up .env, or export them first.
 *
 * CACHE NOTE: this script writes straight to the database and Drime —
 * it does not (and, running as a separate process, cannot) touch the
 * live server's in-memory mediaItemCache. Any deleted track that was
 * recently streamed could keep resolving from that cache for up to
 * MEDIA_ITEM_CACHE_TTL_MS (6 hours by default — see
 * lib/mediaItemCache.js) unless the backend is restarted after this
 * script runs.
 */

require('dotenv').config();
const supabase = require('../lib/supabaseClient');
const { decrypt } = require('../lib/crypto');
const drime = require('../lib/drime');
const coverImageStorage = require('../lib/coverImageStorage');

// Same reasoning as the PAGE_SIZE pagination in routes/media.js —
// Supabase/PostgREST caps every single SELECT response at the
// project's max-rows setting (1000 by default), so a plain select('*')
// on a table with more rows than that silently truncates.
const PAGE_SIZE = 1000;
async function fetchAllRows(buildQuery) {
  let all = [];
  let from = 0;
  while (true) {
    const { data, error } = await buildQuery().range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    all = all.concat(data || []);
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

function parseArgs(argv) {
  return { confirm: argv.includes('--confirm') };
}

async function deleteDrimeAudioFile(item, summary) {
  if (!item.storage_account_id || !item.storage_file_id) return;
  try {
    const { data: account } = await supabase.from('storage_accounts').select('*').eq('id', item.storage_account_id).single();
    if (!account) return;
    const creds = JSON.parse(decrypt(account.credentials_enc));
    await drime.deleteFile({ accessToken: creds.accessToken, fileEntryId: item.storage_file_id });
    summary.audioFilesDeleted++;
  } catch (e) {
    console.error(`  (audio file left on Drime for "${item.title}" — delete failed: ${e.response?.data?.message || e.message})`);
    summary.audioFileErrors++;
  }
}

async function deleteDrimeCoverFile(album, summary) {
  if (!album.image_storage_account_id || !album.image_storage_file_id) return;
  try {
    await coverImageStorage.deleteImage({ accountId: album.image_storage_account_id, storageFileId: album.image_storage_file_id });
    summary.coverFilesDeleted++;
  } catch (e) {
    console.error(`  (cover file left on Drime for album "${album.name}" — delete failed: ${e.response?.data?.message || e.message})`);
    summary.coverFileErrors++;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(args.confirm
    ? 'Running for real — this will permanently delete all music.\n'
    : 'DRY RUN — nothing will be deleted. Pass --confirm to actually delete.\n');

  const summary = {
    musicItems: 0, albums: 0,
    audioFilesDeleted: 0, audioFileErrors: 0,
    coverFilesDeleted: 0, coverFileErrors: 0,
    playProgressRowsDeleted: 0, favoritesRowsDeleted: 0
  };

  const musicItems = await fetchAllRows(() => supabase.from('media_items').select('*').eq('type', 'music'));
  const albums = await fetchAllRows(() => supabase.from('albums').select('*'));
  summary.musicItems = musicItems.length;
  summary.albums = albums.length;

  console.log(`Found ${musicItems.length} music track(s) across ${albums.length} album(s). Audio stories are not affected.\n`);

  if (musicItems.length === 0 && albums.length === 0) {
    console.log('Nothing to delete.');
    return;
  }

  const musicItemIds = musicItems.map((m) => m.id);

  // ---- 1) Delete underlying audio files from Drime ----
  console.log('Deleting audio files from Drime...');
  for (const item of musicItems) {
    if (args.confirm) await deleteDrimeAudioFile(item, summary);
    else if (item.storage_account_id && item.storage_file_id) summary.audioFilesDeleted++; // dry-run count
  }

  // ---- 2) Delete album cover files from Drime ----
  console.log('Deleting album cover images from Drime...');
  for (const album of albums) {
    if (args.confirm) await deleteDrimeCoverFile(album, summary);
    else if (album.image_storage_account_id && album.image_storage_file_id) summary.coverFilesDeleted++; // dry-run count
  }

  if (!args.confirm) {
    console.log('\n--- Dry run summary ---');
    console.log(`Music tracks that would be deleted:        ${summary.musicItems}`);
    console.log(`Albums that would be deleted:               ${summary.albums}`);
    console.log(`Drime audio files that would be deleted:    ${summary.audioFilesDeleted}`);
    console.log(`Drime cover files that would be deleted:    ${summary.coverFilesDeleted}`);
    console.log('\nRe-run with --confirm to actually delete. Audio stories are never touched.');
    return;
  }

  // ---- 3) Delete dependent play_progress / favorites rows first, so
  // the media_items delete below doesn't hit a foreign-key violation
  // (see header comment — no ON DELETE CASCADE on either table). ----
  if (musicItemIds.length > 0) {
    const { error: progressErr, count: progressCount } = await supabase
      .from('play_progress').delete({ count: 'exact' }).in('media_item_id', musicItemIds);
    if (progressErr) throw new Error('Failed to clear play_progress: ' + progressErr.message);
    summary.playProgressRowsDeleted = progressCount || 0;

    const { error: favErr, count: favCount } = await supabase
      .from('favorites').delete({ count: 'exact' }).in('media_item_id', musicItemIds);
    if (favErr) throw new Error('Failed to clear favorites: ' + favErr.message);
    summary.favoritesRowsDeleted = favCount || 0;
  }

  // ---- 4) Delete the music rows themselves (before albums, since
  // media_items.album_id references albums(id)) ----
  if (musicItemIds.length > 0) {
    const { error: delMusicErr } = await supabase.from('media_items').delete().in('id', musicItemIds);
    if (delMusicErr) throw new Error('Failed to delete music rows: ' + delMusicErr.message);
  }

  // ---- 5) Delete the albums table rows ----
  if (albums.length > 0) {
    const { error: delAlbumsErr } = await supabase.from('albums').delete().in('id', albums.map((a) => a.id));
    if (delAlbumsErr) throw new Error('Failed to delete albums: ' + delAlbumsErr.message);
  }

  console.log('\n--- Done ---');
  console.log(`Music tracks deleted:              ${summary.musicItems}`);
  console.log(`Albums deleted:                    ${summary.albums}`);
  console.log(`Drime audio files deleted:         ${summary.audioFilesDeleted} (${summary.audioFileErrors} failed, left on Drime)`);
  console.log(`Drime cover files deleted:         ${summary.coverFilesDeleted} (${summary.coverFileErrors} failed, left on Drime)`);
  console.log(`play_progress rows cleared:        ${summary.playProgressRowsDeleted}`);
  console.log(`favorites rows cleared:            ${summary.favoritesRowsDeleted}`);
  console.log('\nAudio stories, story series, and their cover images were not touched.');
  console.log('If the backend server is running, restart it (or wait out MEDIA_ITEM_CACHE_TTL_MS)');
  console.log('so it stops serving any deleted track from its in-memory cache — see header comment.');
}

main().catch((e) => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});