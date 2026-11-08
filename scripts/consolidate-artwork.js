#!/usr/bin/env node
/**
 * One-off migration for existing data: gets the catalog into the
 * "ONE ALBUM = ONE IMAGE / ONE SERIES = ONE IMAGE" state and then reclaims the
 * duplicate images that were left on Drime.
 *
 * SAFE BY DEFAULT: dry run unless you pass --confirm. Phases run in a fixed order
 * and every deletion happens LAST, after all database references were repointed
 * and re-verified:
 *
 *   1. ALBUMS   Merge album rows with the same normalized name AND the same
 *               release year (both unknown counts as the same). Albums with the
 *               same name but DIFFERENT years are never merged. Tracks are moved
 *               to the surviving album; the survivor keeps one valid image.
 *   2. SERIES   Merge series rows with the same normalized title; episodes move to
 *               the survivor.
 *   3. PROMOTE  An album/series with no artwork whose tracks/episodes do carry
 *               artwork adopts the most common one (so nothing "goes missing").
 *   4. MIRROR   Every track/episode (and every story follow) gets its parent's
 *               artwork URL, so even older app builds that read the per-item
 *               column show the same image as the parent.
 *   5. ORPHANS  Drime image files that NOTHING references any more (no album,
 *               series, track, episode or follow) are deleted — each one re-checked
 *               against the database immediately before it is deleted. Files newer
 *               than --min-age-minutes are skipped so an upload that is still being
 *               registered is never touched.
 *
 * USAGE (from backend/, so dotenv picks up .env)
 *   node scripts/consolidate-artwork.js                      # dry run: prints everything it would do
 *   node scripts/consolidate-artwork.js --confirm            # apply
 *   node scripts/consolidate-artwork.js --confirm --skip-drime   # DB phases only, don't touch Drime
 *   node scripts/consolidate-artwork.js --min-age-minutes=60
 *
 * After a successful --confirm run, re-run supabase/migration_centralized_artwork.sql
 * once: its unique indexes can only be created once the duplicates are gone.
 *
 * Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TOKEN_ENC_KEY (same as the backend).
 */

require('dotenv').config();
const supabase = require('../lib/supabaseClient');
const { decrypt } = require('../lib/crypto');
const drime = require('../lib/drime');
const { normalizeKey } = require('../lib/artwork');

const args = process.argv.slice(2);
const CONFIRM = args.includes('--confirm');
const SKIP_DRIME = args.includes('--skip-drime');
const MIN_AGE_MIN = Number((args.find((a) => a.startsWith('--min-age-minutes=')) || '').split('=')[1] || 30);
const OUR_PREFIXES = ['album-', 'story-']; // filenames lib/coverImageStorage.js has ever produced

const say = (m = '') => console.log(m);
const act = (m) => say(`${CONFIRM ? '  DO ' : '  would'} ${m}`);

const COVER_URL_RE = /\/api\/storage\/cover\/([^/?#]+)\/([^/?#]+)/;
function parseCoverUrl(url) {
  const m = COVER_URL_RE.exec(url || '');
  return m ? { accountId: m[1], hash: m[2] } : null;
}

async function fetchAll(table, columns) {
  let all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(columns).order('id').range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    all = all.concat(data || []);
    if (!data || data.length < 1000) break;
  }
  return all;
}

async function mustUpdate(table, patch, filterFn) {
  const q = filterFn(supabase.from(table).update(patch));
  const { error } = await q;
  if (error) throw new Error(`${table} update failed: ${error.message}`);
}

function pickKeeper(rows, countKey) {
  return [...rows].sort((a, b) =>
    (Boolean(b.cover_image_url) - Boolean(a.cover_image_url)) ||
    (Boolean(b.image_storage_file_id) - Boolean(a.image_storage_file_id)) ||
    ((b[countKey] || 0) - (a[countKey] || 0)) ||
    String(a.created_at).localeCompare(String(b.created_at))
  )[0];
}

/* ---------------------------------------------------------------- phase 1 */
async function mergeAlbums() {
  say('\n=== Phase 1: albums (identity = name + release year) ===');
  const albums = await fetchAll('albums', '*');
  const groups = new Map();
  for (const a of albums) {
    const key = `${normalizeKey(a.name)}|${a.release_year ?? ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }

  // Informational only: same name, different years -> intentionally kept apart.
  const byName = new Map();
  for (const a of albums) {
    const k = normalizeKey(a.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(a);
  }
  for (const [name, rows] of byName) {
    const years = [...new Set(rows.map((r) => r.release_year ?? 'unknown'))];
    if (years.length > 1) {
      say(`  keeping SEPARATE (different release years): "${rows[0].name}" -> ${years.join(', ')}`);
      if (years.includes('unknown')) {
        say('    ! one of them has no release year. If it is a dated edition, set it with PATCH /api/media/albums/:id {releaseYear}.');
      }
    }
  }

  let merged = 0;
  const survivors = [];
  const remap = new Map(); // loser id -> keeper id (so a dry run can project the end state)
  for (const rows of groups.values()) {
    if (rows.length < 2) { survivors.push(rows[0]); continue; }
    const keeper = pickKeeper(rows, 'track_count');
    survivors.push(keeper);
    const losers = rows.filter((r) => r.id !== keeper.id);
    losers.forEach((l) => remap.set(l.id, keeper.id));
    say(`  "${keeper.name}" (${keeper.release_year ?? 'year unknown'}): ${rows.length} rows -> keep ${keeper.id}`);
    for (const loser of losers) {
      act(`move tracks of album ${loser.id} (${loser.artist || 'no artist'}) -> ${keeper.id}, then remove the empty duplicate row`);
      if (CONFIRM) {
        await mustUpdate('media_items', { album_id: keeper.id, album_or_series: keeper.name }, (q) => q.eq('album_id', loser.id));
        if (!keeper.cover_image_url && loser.cover_image_url) {
          const patch = {
            cover_image_url: loser.cover_image_url,
            image_storage_account_id: loser.image_storage_account_id,
            image_storage_file_id: loser.image_storage_file_id,
            image_storage_hash: loser.image_storage_hash
          };
          await mustUpdate('albums', patch, (q) => q.eq('id', keeper.id));
          Object.assign(keeper, patch);
        }
        const { error } = await supabase.from('albums').delete().eq('id', loser.id);
        if (error) throw new Error('albums delete failed: ' + error.message);
      }
      merged++;
    }
    if (CONFIRM) {
      const { count } = await supabase.from('media_items').select('id', { count: 'exact', head: true }).eq('album_id', keeper.id);
      await mustUpdate('albums', { track_count: count ?? 0 }, (q) => q.eq('id', keeper.id));
    }
  }
  say(`  ${merged} duplicate album row(s) ${CONFIRM ? 'merged' : 'to merge'}.`);
  return { survivors, remap };
}

/* ---------------------------------------------------------------- phase 2 */
async function mergeSeries() {
  say('\n=== Phase 2: series (identity = title) ===');
  const series = await fetchAll('story_series', '*');
  const groups = new Map();
  for (const s of series) {
    const key = normalizeKey(s.title);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  let merged = 0;
  const survivors = [];
  const remap = new Map();
  for (const rows of groups.values()) {
    if (rows.length < 2) { survivors.push(rows[0]); continue; }
    const keeper = pickKeeper(rows, 'episode_count');
    survivors.push(keeper);
    rows.filter((r) => r.id !== keeper.id).forEach((l) => remap.set(l.id, keeper.id));
    say(`  "${keeper.title}": ${rows.length} rows -> keep ${keeper.id}`);
    for (const loser of rows.filter((r) => r.id !== keeper.id)) {
      act(`move episodes of series ${loser.id} -> ${keeper.id}, then remove the duplicate row`);
      if (CONFIRM) {
        await mustUpdate('media_items',
          { story_series_id: keeper.id, album_or_series: keeper.title, story_title: keeper.title },
          (q) => q.eq('story_series_id', loser.id));
        if (!keeper.cover_image_url && loser.cover_image_url) {
          const patch = {
            cover_image_url: loser.cover_image_url,
            image_storage_account_id: loser.image_storage_account_id,
            image_storage_file_id: loser.image_storage_file_id,
            image_storage_hash: loser.image_storage_hash
          };
          await mustUpdate('story_series', patch, (q) => q.eq('id', keeper.id));
          Object.assign(keeper, patch);
        }
        const { error } = await supabase.from('story_series').delete().eq('id', loser.id);
        if (error) throw new Error('story_series delete failed: ' + error.message);
      }
      merged++;
    }
    if (CONFIRM) {
      const { count } = await supabase.from('media_items').select('id', { count: 'exact', head: true }).eq('story_series_id', keeper.id);
      await mustUpdate('story_series', { episode_count: count ?? 0 }, (q) => q.eq('id', keeper.id));
    }
  }
  say(`  ${merged} duplicate series row(s) ${CONFIRM ? 'merged' : 'to merge'}.`);
  return { survivors, remap };
}

/* ---------------------------------------------------------------- Drime helpers */
async function loadDrime() {
  if (SKIP_DRIME) return { accounts: [], entriesByAccount: new Map() };
  const { data: accounts, error } = await supabase.from('storage_accounts').select('*').eq('purpose', 'image');
  if (error) throw new Error('storage_accounts: ' + error.message);
  const entriesByAccount = new Map();
  for (const account of accounts || []) {
    const creds = JSON.parse(decrypt(account.credentials_enc));
    let all = [];
    for (let page = 1; ; page++) {
      const resp = await drime.listEntries({ accessToken: creds.accessToken, workspaceId: creds.workspaceId, folderId: creds.folderId, page });
      const batch = resp.data || [];
      all = all.concat(batch);
      const last = resp.last_page || Math.ceil((resp.total || all.length) / (batch.length || 1));
      if (batch.length === 0 || page >= last) break;
    }
    entriesByAccount.set(account.id, { account, creds, entries: all });
  }
  return { accounts: accounts || [], entriesByAccount };
}

/* ---------------------------------------------------------------- phase 3 */
async function promoteArtwork(drimeInfo) {
  say('\n=== Phase 3: albums/series with missing artwork that their tracks still have ===');
  const hashToEntry = new Map();
  for (const [accountId, info] of drimeInfo.entriesByAccount) {
    for (const e of info.entries) if (e.hash) hashToEntry.set(`${accountId}:${e.hash}`, e);
  }

  async function run(table, parentCol, label) {
    const parents = await fetchAll(table, '*');
    const missing = parents.filter((p) => !p.cover_image_url);
    let promoted = 0;
    for (const p of missing) {
      const { data: items, error } = await supabase.from('media_items').select('cover_image_url').eq(parentCol, p.id).not('cover_image_url', 'is', null);
      if (error) throw new Error(error.message);
      const counts = new Map();
      for (const it of items || []) counts.set(it.cover_image_url, (counts.get(it.cover_image_url) || 0) + 1);
      if (counts.size === 0) continue;
      const [url] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      const parsed = parseCoverUrl(url);
      const entry = parsed ? hashToEntry.get(`${parsed.accountId}:${parsed.hash}`) : null;
      act(`${label} ${p.id} ("${p.name || p.title}") adopts its most common track artwork ${url}`);
      if (CONFIRM) {
        await mustUpdate(table, {
          cover_image_url: url,
          image_storage_account_id: parsed?.accountId || null,
          image_storage_hash: parsed?.hash || null,
          image_storage_file_id: entry ? String(entry.id) : null
        }, (q) => q.eq('id', p.id));
      }
      promoted++;
    }
    say(`  ${promoted} ${label}(s) ${CONFIRM ? 'updated' : 'to update'}.`);
  }
  await run('albums', 'album_id', 'album');
  await run('story_series', 'story_series_id', 'series');
}

/* ---------------------------------------------------------------- phase 4 */
// Rows whose cover_image_url is null or different from `url` (two plain queries:
// no URL ever gets spliced into a PostgREST filter expression).
async function countMismatched(table, scope, url) {
  const nulls = await scope(supabase.from(table).select('*', { count: 'exact', head: true })).is('cover_image_url', null);
  const diff = await scope(supabase.from(table).select('*', { count: 'exact', head: true })).neq('cover_image_url', url);
  if (nulls.error) throw new Error(nulls.error.message);
  if (diff.error) throw new Error(diff.error.message);
  return (nulls.count || 0) + (diff.count || 0);
}

async function mirrorArtwork() {
  say('\n=== Phase 4: every track/episode/follow points at its parent\'s single image ===');
  let touchedItems = 0;

  async function run(table, parentCol) {
    const parents = (await fetchAll(table, '*')).filter((p) => p.cover_image_url);
    for (const p of parents) {
      const count = await countMismatched('media_items', (q) => q.eq(parentCol, p.id), p.cover_image_url);
      if (!count) continue;
      act(`${count} item(s) of ${table} ${p.id} ("${p.name || p.title}") -> ${p.cover_image_url}`);
      if (CONFIRM) await mustUpdate('media_items', { cover_image_url: p.cover_image_url }, (q) => q.eq(parentCol, p.id));
      touchedItems += count;
    }
  }
  await run('albums', 'album_id');
  await run('story_series', 'story_series_id');
  say(`  ${touchedItems} track/episode cover reference(s) ${CONFIRM ? 'updated' : 'to update'}.`);

  const series = (await fetchAll('story_series', 'id, title, cover_image_url')).filter((s) => s.cover_image_url);
  let follows = 0;
  for (const s of series) {
    const count = await countMismatched('story_follows', (q) => q.eq('series_key', s.title), s.cover_image_url);
    if (!count) continue;
    act(`${count} follow(s) of "${s.title}" -> ${s.cover_image_url}`);
    if (CONFIRM) await mustUpdate('story_follows', { cover_image_url: s.cover_image_url }, (q) => q.eq('series_key', s.title));
    follows += count;
  }
  say(`  ${follows} follow cover snapshot(s) ${CONFIRM ? 'updated' : 'to update'}.`);
  say('  NOTE: run this against a quiet backend, or restart it afterwards, so its in-memory media cache re-reads the rows.');
}

/* ---------------------------------------------------------------- phase 5 */
async function stillReferenced(entry, accountId) {
  const id = String(entry.id);
  const hash = entry.hash;
  const checks = [
    supabase.from('albums').select('id', { count: 'exact', head: true }).eq('image_storage_file_id', id),
    supabase.from('story_series').select('id', { count: 'exact', head: true }).eq('image_storage_file_id', id)
  ];
  if (hash) {
    const pat = `%/api/storage/cover/${accountId}/${hash}%`;
    for (const t of ['albums', 'story_series', 'media_items', 'story_follows']) {
      checks.push(supabase.from(t).select('*', { count: 'exact', head: true }).ilike('cover_image_url', pat));
    }
    checks.push(supabase.from('albums').select('id', { count: 'exact', head: true }).eq('image_storage_hash', hash));
    checks.push(supabase.from('story_series').select('id', { count: 'exact', head: true }).eq('image_storage_hash', hash));
  }
  const results = await Promise.all(checks);
  for (const r of results) {
    if (r.error) return true; // can't verify -> treat as referenced (never delete on doubt)
    if ((r.count || 0) > 0) return true;
  }
  return false;
}

// What will be referenced once every phase above has run. In --confirm mode the
// database has ALREADY been changed, so it is simply read back (authoritative).
// In a dry run nothing was changed, so the end state is projected from the
// surviving parents: every item with a parent points at that parent's single
// image, so only the parent's image (own, or the one it would adopt) is kept.
async function collectReferences(plan) {
  const refIds = new Set();
  const refHashes = new Set();
  const addUrl = (url) => { const p = parseCoverUrl(url); if (p) refHashes.add(p.hash); };

  const items = await fetchAll('media_items', 'id, cover_image_url, album_id, story_series_id');
  const follows = await fetchAll('story_follows', 'series_key, cover_image_url').catch(() => []);

  if (CONFIRM) {
    const albums = await fetchAll('albums', 'image_storage_file_id, image_storage_hash, cover_image_url');
    const series = await fetchAll('story_series', 'image_storage_file_id, image_storage_hash, cover_image_url');
    for (const r of [...albums, ...series]) {
      if (r.image_storage_file_id) refIds.add(String(r.image_storage_file_id));
      if (r.image_storage_hash) refHashes.add(r.image_storage_hash);
    }
    for (const r of [...albums, ...series, ...items, ...follows]) addUrl(r.cover_image_url);
    return { refIds, refHashes };
  }

  const parentOf = (it) => {
    if (it.album_id) return { kind: 'a', id: plan.albums.remap.get(it.album_id) || it.album_id };
    if (it.story_series_id) return { kind: 's', id: plan.series.remap.get(it.story_series_id) || it.story_series_id };
    return null;
  };
  const survivors = new Map([
    ...plan.albums.survivors.map((a) => [`a:${a.id}`, a]),
    ...plan.series.survivors.map((s) => [`s:${s.id}`, s])
  ]);
  const itemCovers = new Map(); // parent key -> Map(url -> count)
  for (const it of items) {
    const par = parentOf(it);
    if (!par || !it.cover_image_url) continue;
    const k = `${par.kind}:${par.id}`;
    if (!itemCovers.has(k)) itemCovers.set(k, new Map());
    const m = itemCovers.get(k);
    m.set(it.cover_image_url, (m.get(it.cover_image_url) || 0) + 1);
  }
  const effective = new Map(); // parent key -> final cover url
  for (const [k, row] of survivors) {
    if (row.cover_image_url) {
      effective.set(k, row.cover_image_url);
      if (row.image_storage_file_id) refIds.add(String(row.image_storage_file_id));
      if (row.image_storage_hash) refHashes.add(row.image_storage_hash);
      addUrl(row.cover_image_url);
    } else if (itemCovers.has(k)) {
      const [url] = [...itemCovers.get(k).entries()].sort((x, y) => y[1] - x[1])[0]; // phase 3 promotion
      effective.set(k, url);
      addUrl(url);
    }
  }
  for (const it of items) {
    const par = parentOf(it);
    const hasParentCover = par && effective.has(`${par.kind}:${par.id}`) && survivors.has(`${par.kind}:${par.id}`);
    if (!hasParentCover) addUrl(it.cover_image_url); // singles / parents with no artwork keep their own
  }
  const seriesByTitle = new Map(plan.series.survivors.map((s) => [normalizeKey(s.title), `s:${s.id}`]));
  for (const f of follows) {
    const k = seriesByTitle.get(normalizeKey(f.series_key));
    if (!(k && effective.has(k))) addUrl(f.cover_image_url);
  }
  return { refIds, refHashes };
}

async function removeOrphans(drimeInfo, plan) {
  say('\n=== Phase 5: Drime image files nothing references any more ===');
  if (SKIP_DRIME) { say('  skipped (--skip-drime).'); return; }
  if (drimeInfo.entriesByAccount.size === 0) { say('  no image-purpose Drime accounts.'); return; }
  if (!CONFIRM) say('  (projected end state: includes per-track copies that phase 4 will make unreferenced)');

  const { refIds, refHashes } = await collectReferences(plan);

  const cutoff = Date.now() - MIN_AGE_MIN * 60 * 1000;
  const summary = { scanned: 0, kept: 0, tooNew: 0, notOurs: 0, orphaned: 0, deleted: 0, errors: 0, bytes: 0 };

  for (const [accountId, info] of drimeInfo.entriesByAccount) {
    say(`  account "${info.account.label}": ${info.entries.length} file(s)`);
    for (const e of info.entries) {
      summary.scanned++;
      if (e.type === 'folder') { summary.notOurs++; continue; }
      if (!OUR_PREFIXES.some((p) => String(e.name || '').startsWith(p))) { summary.notOurs++; continue; }
      if (refIds.has(String(e.id)) || (e.hash && refHashes.has(e.hash))) { summary.kept++; continue; }
      const created = e.created_at ? Date.parse(e.created_at) : NaN;
      // Too new (an upload may still be mid-registration) or unknown age -> leave alone.
      if (!Number.isFinite(created) || created > cutoff) { summary.tooNew++; continue; }

      summary.orphaned++;
      summary.bytes += Number(e.file_size || 0);
      if (!CONFIRM) { say(`    would delete ${e.name} (id ${e.id})`); continue; }

      // Last line of defence: re-verify against the live database right before deleting.
      if (await stillReferenced(e, accountId)) { summary.kept++; summary.orphaned--; say(`    KEPT ${e.name}: still referenced`); continue; }
      try {
        await drime.deleteFile({ accessToken: info.creds.accessToken, fileEntryId: e.id });
        summary.deleted++;
        say(`    deleted ${e.name}`);
      } catch (err) {
        summary.errors++;
        console.error(`    FAILED ${e.name}: ${err.response?.data?.message || err.message}`);
      }
    }
  }
  say(`  scanned ${summary.scanned}; in use ${summary.kept}; not ours ${summary.notOurs}; too new/unknown age ${summary.tooNew}`);
  say(`  unreferenced ${summary.orphaned} (~${(summary.bytes / 1024 / 1024).toFixed(1)} MB)` +
    (CONFIRM ? `; deleted ${summary.deleted}; failed ${summary.errors}` : ''));
}

/* ---------------------------------------------------------------- main */
async function main() {
  say(CONFIRM
    ? 'Running for real (--confirm). Database references are repointed first; Drime files are deleted last.'
    : 'DRY RUN - nothing is changed. Re-run with --confirm to apply.');

  const plan = { albums: await mergeAlbums(), series: await mergeSeries() };
  const drimeInfo = await loadDrime();
  await promoteArtwork(drimeInfo);
  await mirrorArtwork();
  await removeOrphans(drimeInfo, plan);

  say('\nDone.' + (CONFIRM ? ' Now re-run supabase/migration_centralized_artwork.sql to add the unique indexes.' : ''));
}

if (require.main === module) {
  main().catch((e) => {
    console.error('Fatal:', e.message);
    process.exit(1);
  });
} else {
  module.exports = { main }; // for tests
}
