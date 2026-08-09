#!/usr/bin/env node
/**
 * One-off follow-up to delete-all-music.js: reclaims cover-image files
 * left behind on Drime when that script's best-effort per-album delete
 * failed (e.g. "The selected entry ids is invalid" — the id on record
 * no longer matched a live Drime file, for whatever reason).
 *
 * WHY THIS CAN DELETE BY FILENAME PREFIX ALONE, SAFELY
 * delete-all-music.js already deleted every `albums` row from the
 * database. That means the specific file id that failed to delete is
 * gone from our data too — there is no longer any row to look it up by.
 * But every album cover was uploaded through coverImageStorage.js with
 * filename `album-<timestamp>-<random>.jpg` (see uploadImage's prefix
 * param, always 'album' for music/album covers, 'story' for story_series
 * covers — see routes/media.js findOrCreateAlbum vs
 * findOrCreateStorySeries). Since every album is now gone, ANY file on
 * the 'image'-purpose Drime account(s) whose name starts with "album-"
 * is guaranteed orphaned, full stop — nothing in the database can
 * reference it anymore. This script lists every file in those
 * accounts and deletes exactly the ones matching that prefix, leaving
 * "story-" files (and anything else) completely alone.
 *
 * SAFE BY DEFAULT: dry run unless you pass --confirm, same as
 * delete-all-music.js.
 *
 * USAGE
 *   cd backend
 *   node scripts/cleanup-orphaned-covers.js              # dry run
 *   node scripts/cleanup-orphaned-covers.js --confirm     # actually deletes
 *
 * Needs the same env vars as the backend itself (SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY, TOKEN_ENC_KEY) — run from backend/ so
 * dotenv picks up .env, or export them first.
 */

require('dotenv').config();
const supabase = require('../lib/supabaseClient');
const { decrypt } = require('../lib/crypto');
const drime = require('../lib/drime');

function parseArgs(argv) {
  return { confirm: argv.includes('--confirm') };
}

async function listAllEntries({ accessToken, workspaceId, folderId }) {
  let all = [];
  let page = 1;
  while (true) {
    const resp = await drime.listEntries({ accessToken, workspaceId, folderId, page });
    const batch = resp.data || [];
    all = all.concat(batch);
    const lastPage = resp.last_page || Math.ceil((resp.total || all.length) / (batch.length || 1));
    if (batch.length === 0 || page >= lastPage) break;
    page++;
  }
  return all;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(args.confirm
    ? 'Running for real — orphaned "album-" cover files will be permanently deleted.\n'
    : 'DRY RUN — nothing will be deleted. Pass --confirm to actually delete.\n');

  const { data: accounts, error: acctErr } = await supabase
    .from('storage_accounts').select('*').eq('purpose', 'image');
  if (acctErr) throw new Error('Failed to load image storage accounts: ' + acctErr.message);
  if (!accounts || accounts.length === 0) {
    console.log('No image-purpose storage accounts found — nothing to clean up.');
    return;
  }

  const summary = { scanned: 0, matched: 0, deleted: 0, errors: 0 };

  for (const account of accounts) {
    console.log(`Account "${account.label}":`);
    const creds = JSON.parse(decrypt(account.credentials_enc));

    let entries;
    try {
      entries = await listAllEntries({ accessToken: creds.accessToken, workspaceId: creds.workspaceId, folderId: creds.folderId });
    } catch (e) {
      console.error(`  FAILED to list files: ${e.response?.data?.message || e.message}`);
      continue;
    }
    summary.scanned += entries.length;

    const orphaned = entries.filter((e) => typeof e.name === 'string' && e.name.startsWith('album-'));
    summary.matched += orphaned.length;
    console.log(`  ${entries.length} file(s) total, ${orphaned.length} match the orphaned "album-" prefix.`);

    for (const entry of orphaned) {
      if (!args.confirm) {
        console.log(`  Would delete: ${entry.name} (id ${entry.id})`);
        continue;
      }
      try {
        await drime.deleteFile({ accessToken: creds.accessToken, fileEntryId: entry.id });
        summary.deleted++;
        console.log(`  Deleted: ${entry.name}`);
      } catch (e) {
        summary.errors++;
        console.error(`  FAILED to delete ${entry.name} (id ${entry.id}): ${e.response?.data?.message || e.message}`);
      }
    }
  }

  console.log('\n--- Summary ---');
  console.log(`Files scanned:            ${summary.scanned}`);
  console.log(`Orphaned "album-" files:  ${summary.matched}`);
  if (args.confirm) {
    console.log(`Deleted:                  ${summary.deleted}`);
    console.log(`Failed:                   ${summary.errors}`);
  } else {
    console.log('\nRe-run with --confirm to actually delete these.');
  }
}

main().catch((e) => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});