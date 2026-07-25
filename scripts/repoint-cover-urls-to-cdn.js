#!/usr/bin/env node
/**
 * One-off: repoint every existing cover_image_url (albums, story_series,
 * and the denormalized copy on media_items) from this backend's own
 * domain onto a CDN/edge-cache domain sitting in front of it — see
 * /cdn-worker and IMAGE_PERFORMANCE.md.
 *
 * This does NOT touch Drime or re-upload anything. Every cover URL has
 * always been `<some base>/api/storage/cover/:accountId/:hash` (see
 * routes/storage.js), and that route still lives on this backend
 * regardless of what sits in front of it — so this is a pure string
 * rewrite of the base, run once against the database. New uploads made
 * after IMAGE_CDN_BASE_URL is set already get the CDN base automatically
 * (see coverBaseUrl() in routes/storage.js); this script is only for
 * covers uploaded *before* that env var was set.
 *
 * USAGE
 *   cd backend
 *   npm install   # if you haven't already
 *
 *   # Preview what would change, no writes:
 *   node scripts/repoint-cover-urls-to-cdn.js --to=https://swarkatha-covers.<you>.workers.dev --dry-run
 *
 *   # Actually rewrite:
 *   node scripts/repoint-cover-urls-to-cdn.js --to=https://swarkatha-covers.<you>.workers.dev
 *
 * Needs the same env vars the backend itself uses (SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY, and either BASE_URL or --from=... below) —
 * run from the backend/ folder so `require('dotenv').config()` picks up
 * your .env, or export them in the shell first.
 *
 * Safe to re-run: any row whose cover_image_url already starts with
 * --to is left alone.
 */

require('dotenv').config();
const supabase = require('../lib/supabaseClient');

function parseArgs(argv) {
  const args = { dryRun: false };
  for (const raw of argv) {
    if (raw === '--dry-run') args.dryRun = true;
    else if (raw.startsWith('--to=')) args.to = raw.slice('--to='.length).replace(/\/$/, '');
    else if (raw.startsWith('--from=')) args.from = raw.slice('--from='.length).replace(/\/$/, '');
  }
  return args;
}

function resolveFromBase(args) {
  const from = args.from || process.env.BASE_URL;
  if (!from || /your-backend\.onrender\.com/.test(from)) {
    throw new Error(
      'Pass --from=<current cover URL base> (or set BASE_URL) so this script knows which URLs to rewrite. ' +
      'Found: ' + (from || '(empty)')
    );
  }
  return from;
}

// Rewrites "<from>/api/storage/cover/<accountId>/<hash>" to
// "<to>/api/storage/cover/<accountId>/<hash>", leaving anything that
// doesn't match that shape (already-migrated, or unrelated) untouched.
function repoint(url, from, to) {
  const marker = '/api/storage/cover/';
  if (typeof url !== 'string' || !url.startsWith(`${from}${marker}`)) return null;
  return `${to}${marker}${url.slice((`${from}${marker}`).length)}`;
}

async function repointTable({ table, idColumn, from, to, dryRun }) {
  const { data: rows, error } = await supabase.from(table).select(`${idColumn}, cover_image_url`).not('cover_image_url', 'is', null);
  if (error) throw new Error(`Failed to load ${table}: ${error.message}`);

  let changed = 0;
  for (const row of rows || []) {
    const newUrl = repoint(row.cover_image_url, from, to);
    if (!newUrl) continue;
    changed++;
    if (dryRun) {
      console.log(`[dry run] ${table}.${idColumn}=${row[idColumn]}: ${row.cover_image_url} -> ${newUrl}`);
      continue;
    }
    const { error: updErr } = await supabase.from(table).update({ cover_image_url: newUrl }).eq(idColumn, row[idColumn]);
    if (updErr) console.error(`  failed to update ${table}.${idColumn}=${row[idColumn]}: ${updErr.message}`);
  }
  console.log(`${table}: ${changed} row(s) ${dryRun ? 'would be' : ''} updated (of ${rows?.length || 0} with a cover set).`);
  return changed;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.to) throw new Error('Pass --to=<CDN base URL>, e.g. --to=https://swarkatha-covers.<you>.workers.dev');
  const from = resolveFromBase(args);

  console.log(`Repointing cover_image_url: ${from} -> ${args.to}${args.dryRun ? '  [dry run]' : ''}\n`);

  let total = 0;
  total += await repointTable({ table: 'albums', idColumn: 'id', from, to: args.to, dryRun: args.dryRun });
  total += await repointTable({ table: 'story_series', idColumn: 'id', from, to: args.to, dryRun: args.dryRun });
  total += await repointTable({ table: 'media_items', idColumn: 'id', from, to: args.to, dryRun: args.dryRun });

  console.log(`\nDone. ${total} row(s) ${args.dryRun ? 'would be' : 'were'} updated in total.`);
  if (args.dryRun) console.log('Re-run without --dry-run to apply.');
}

run().catch((e) => {
  console.error('\nFailed:', e.message);
  process.exit(1);
});
