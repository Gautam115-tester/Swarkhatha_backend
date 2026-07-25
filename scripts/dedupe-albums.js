#!/usr/bin/env node
/**
 * One-off cleanup: merge duplicate `albums` rows that share the same
 * name but ended up as separate rows because of the admin-app bug
 * where auto-matching an existing album (by name, during file pick)
 * didn't also sync the artist field to that album's stored artist.
 * Every upload whose freshly-extracted per-track artist tag differed
 * even slightly from the first track's artist failed the backend's
 * exact (name, artist) match in findOrCreateAlbum() and silently
 * created a brand-new album row — which is why e.g. "GLORY" or
 * "International Villager" show up as a dozen+ separate albums today,
 * each with its own (often identical) cover image.
 *
 * This script groups albums by normalized name (trim + case-insensitive),
 * and for every group with more than one row:
 *   1. Picks a canonical row (prefers one that already has a cover
 *      image, tie-broken by earliest created_at).
 *   2. Points every media_items row from the other rows in the group
 *      at the canonical album_id, and backfills cover_image_url on
 *      every track in the group (old and new) to the canonical cover.
 *   3. Recomputes track_count on the canonical row from an actual
 *      count of media_items (rather than trusting the old per-row
 *      counters, which drifted once the duplicates existed).
 *   4. Deletes the now-empty duplicate album rows.
 *
 * Run this BEFORE running migrate-cover-images-to-drime.js for real
 * (not --dry-run) — merging first means only one cover per real album
 * gets uploaded to Drime, instead of one per duplicate row.
 *
 * USAGE
 *   cd backend
 *   node scripts/dedupe-albums.js               # dry run (default) — prints the merge plan, changes nothing
 *   node scripts/dedupe-albums.js --apply        # actually merges and deletes
 *
 * Needs the same env vars as the other scripts (SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY) — run from backend/ so dotenv picks up
 * your .env, or export them in the shell first.
 */

require('dotenv').config();
const supabase = require('../lib/supabaseClient');

function parseArgs(argv) {
  return { apply: argv.includes('--apply') };
}

function normalizeName(name) {
  return String(name || '').trim().toLowerCase();
}

async function run() {
  const { apply } = parseArgs(process.argv.slice(2));

  const { data: albums, error: albumsErr } = await supabase.from('albums').select('*');
  if (albumsErr) throw new Error('Failed to load albums: ' + albumsErr.message);

  const groups = new Map(); // normalized name -> album[]
  for (const album of albums || []) {
    const key = normalizeName(album.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(album);
  }

  const dupGroups = [...groups.values()].filter((g) => g.length > 1);

  if (dupGroups.length === 0) {
    console.log('No duplicate album names found. Nothing to do.');
    process.exit(0);
  }

  console.log(`Found ${dupGroups.length} album name(s) with duplicate rows.\n`);

  const summary = { groupsMerged: 0, albumsDeleted: 0, tracksReassigned: 0, errors: [] };

  for (const group of dupGroups) {
    // Canonical: prefer a row that already has a cover image, tie-break by oldest.
    const sorted = [...group].sort((a, b) => {
      const coverA = a.cover_image_url ? 1 : 0;
      const coverB = b.cover_image_url ? 1 : 0;
      if (coverA !== coverB) return coverB - coverA; // covers first
      return new Date(a.created_at) - new Date(b.created_at); // oldest first
    });
    const canonical = sorted[0];
    const dupes = sorted.slice(1);

    console.log(`"${canonical.name}" — ${group.length} rows, artists seen: [${[...new Set(group.map((a) => a.artist || '(none)'))].join(', ')}]`);
    console.log(`  keeping:  ${canonical.id}  (artist: ${canonical.artist || '(none)'}, cover: ${canonical.cover_image_url ? 'yes' : 'no'})`);
    for (const d of dupes) console.log(`  merging:  ${d.id}  (artist: ${d.artist || '(none)'}, cover: ${d.cover_image_url ? 'yes' : 'no'})`);

    // Resolve the cover every track in the merged album should end up with:
    // canonical's own cover if it has one, else the first duplicate's cover.
    const resolvedCover = canonical.cover_image_url || dupes.find((d) => d.cover_image_url)?.cover_image_url || null;

    if (!apply) {
      console.log('  [dry run] would reassign media_items, backfill cover, recompute track_count, then delete the merged rows.\n');
      continue;
    }

    try {
      const dupeIds = dupes.map((d) => d.id);

      // 1. Point every track from the duplicate rows at the canonical album.
      const { data: reassigned, error: reassignErr } = await supabase
        .from('media_items')
        .update({ album_id: canonical.id, cover_image_url: resolvedCover })
        .in('album_id', dupeIds)
        .select('id');
      if (reassignErr) throw new Error('Reassigning tracks failed: ' + reassignErr.message);
      summary.tracksReassigned += reassigned?.length || 0;

      // 2. Backfill the resolved cover onto tracks that were already on the
      //    canonical row too, so the whole album is visually consistent.
      if (resolvedCover && resolvedCover !== canonical.cover_image_url) {
        const { error: backfillErr } = await supabase
          .from('media_items')
          .update({ cover_image_url: resolvedCover })
          .eq('album_id', canonical.id);
        if (backfillErr) throw new Error('Backfilling canonical cover failed: ' + backfillErr.message);
      }

      // 3. Recompute track_count from reality instead of trusting the old counters.
      const { count, error: countErr } = await supabase
        .from('media_items')
        .select('id', { count: 'exact', head: true })
        .eq('album_id', canonical.id);
      if (countErr) throw new Error('Recounting tracks failed: ' + countErr.message);

      const { error: updCanonicalErr } = await supabase
        .from('albums')
        .update({ cover_image_url: resolvedCover, track_count: count ?? canonical.track_count })
        .eq('id', canonical.id);
      if (updCanonicalErr) throw new Error('Updating canonical album failed: ' + updCanonicalErr.message);

      // 4. Delete the now-empty duplicate rows.
      const { error: delErr } = await supabase.from('albums').delete().in('id', dupeIds);
      if (delErr) throw new Error('Deleting duplicate albums failed: ' + delErr.message);

      summary.albumsDeleted += dupeIds.length;
      summary.groupsMerged += 1;
      console.log('  done.\n');
    } catch (e) {
      console.error(`  FAILED: ${e.message}\n`);
      summary.errors.push({ name: canonical.name, error: e.message });
    }
  }

  console.log('---- Summary ----');
  console.log(`Album names merged:   ${summary.groupsMerged} / ${dupGroups.length}`);
  console.log(`Duplicate rows deleted: ${summary.albumsDeleted}`);
  console.log(`Tracks reassigned:     ${summary.tracksReassigned}`);
  console.log(`Errors:                ${summary.errors.length}`);
  if (summary.errors.length) {
    for (const e of summary.errors) console.log(`  - ${e.name}: ${e.error}`);
  }
  if (!apply) console.log('\n(dry run — no database changes were made; re-run with --apply to merge for real)');

  process.exit(summary.errors.length > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error('Dedupe aborted: ' + e.message);
  process.exit(1);
});
