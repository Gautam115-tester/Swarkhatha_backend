'use strict';
/**
 * Runs the REAL migration + seed + SQL functions against Postgres.
 *   TEST_DATABASE_URL=postgres://user:pw@localhost:5432/dbname node --test test/classification/sql.integration.test.js
 * Skipped when TEST_DATABASE_URL is not set. Everything happens inside a throw-away schema
 * (search_path), so it is safe to point at any scratch database; the schema is dropped at the end.
 * media_items is a minimal stand-in (the functions only use id and type).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const URL = process.env.TEST_DATABASE_URL;
const skip = URL ? false : 'set TEST_DATABASE_URL to run the Postgres integration tests';
const SQL = (f) => fs.readFileSync(path.join(__dirname, '../../supabase', f), 'utf8');
const SCHEMA = `cls_test_${process.pid}`;

let Client; let c;
const newClient = async () => { const cl = new Client({ connectionString: URL, options: `-c search_path=${SCHEMA}` }); await cl.connect(); return cl; };
const q = (text, params) => c.query(text, params);
const one = async (text, params) => (await q(text, params)).rows[0];
const addMusic = async (n = 1, type = 'music') => { const ids = []; for (let i = 0; i < n; i++) ids.push((await one('insert into media_items(type) values ($1) returning id', [type])).id); return ids; };
const labelId = async (dim, slug) => (await one('select id from music_labels where dimension=$1 and slug=$2', [dim, slug])).id;

test.before(async () => {
  if (skip) return;
  ({ Client } = require('pg'));
  const admin = new Client({ connectionString: URL }); await admin.connect();
  await admin.query(`drop schema if exists ${SCHEMA} cascade; create schema ${SCHEMA}`); await admin.end();
  c = await newClient();
  await q('create table media_items (id uuid primary key default gen_random_uuid(), type text not null, title text)');
  await q(SQL('migration_music_classification.sql'));
  await q(SQL('seed_music_labels.sql'));
});
test.after(async () => {
  if (skip) return;
  await c.end();
  const admin = new Client({ connectionString: URL }); await admin.connect(); await admin.query(`drop schema if exists ${SCHEMA} cascade`); await admin.end();
});

test('migration and seed are idempotent; taxonomy is complete with a proper hierarchy', { skip }, async () => {
  await q(SQL('migration_music_classification.sql')); await q(SQL('seed_music_labels.sql'));
  const { n, children } = await one('select count(*)::int n, count(parent_id)::int children from music_labels');
  assert.equal(n, require('../../lib/classification/taxonomy').ALL_LABELS.length);
  assert.ok(children > 10);
  const chain = await q(`with recursive p as (select id, name, parent_id from music_labels where dimension='genre' and slug='bollywood-romantic'
      union all select l.id, l.name, l.parent_id from music_labels l join p on l.id = p.parent_id) select name from p`);
  assert.deepEqual(chain.rows.map((r) => r.name), ['Bollywood Romantic', 'Bollywood', 'Indian Film Music', 'Indian Music']);
  const dims = (await q('select distinct dimension from music_labels order by 1')).rows.map((r) => r.dimension);
  assert.deepEqual(dims, ['characteristic', 'context', 'genre', 'language', 'mood', 'version', 'vocal']);
});

test('constraints: unique (music, label), confidence range, status values, one open job per track', { skip }, async () => {
  const [m] = await addMusic(); const l = await labelId('genre', 'jazz');
  await q("insert into music_track_labels(music_id,label_id,confidence,source,status) values ($1,$2,0.9,'t','approved')", [m, l]);
  await assert.rejects(q("insert into music_track_labels(music_id,label_id,confidence,source,status) values ($1,$2,0.5,'t','approved')", [m, l]), /duplicate key/);
  const l2 = await labelId('genre', 'blues');
  await assert.rejects(q("insert into music_track_labels(music_id,label_id,confidence,source,status) values ($1,$2,1.5,'t','approved')", [m, l2]), /check constraint|out of range/);
  await assert.rejects(q("insert into music_track_labels(music_id,label_id,confidence,source,status) values ($1,$2,0.5,'t','maybe')", [m, l2]), /check constraint/);
  await q('insert into music_classification_jobs(music_id) values ($1)', [m]);
  await assert.rejects(q('insert into music_classification_jobs(music_id) values ($1)', [m]), /uq_mcj_open_job/);
  await q("update music_classification_jobs set status='completed' where music_id=$1", [m]);
  await q('insert into music_classification_jobs(music_id) values ($1)', [m]); // allowed again once finished
  await assert.rejects(q("insert into music_classification_jobs(music_id, status) values ($1,'bogus')", [(await addMusic())[0]]), /check constraint/);
});

test('deleting a track cascades to its labels, jobs, metadata and sources; labels in use cannot be deleted', { skip }, async () => {
  const [m] = await addMusic(); const l = await labelId('mood', 'sad');
  await q("insert into music_track_labels(music_id,label_id,confidence,source,status) values ($1,$2,0.9,'t','approved')", [m, l]);
  await q('insert into music_classification_jobs(music_id) values ($1)', [m]);
  await q('insert into music_classification_metadata(music_id) values ($1)', [m]);
  await q("insert into music_classification_sources(music_id, provider) values ($1,'musicbrainz')", [m]);
  await assert.rejects(q('delete from music_labels where id=$1', [l]), /foreign key/);
  await q('delete from media_items where id=$1', [m]);
  for (const t of ['music_track_labels', 'music_classification_jobs', 'music_classification_metadata', 'music_classification_sources']) {
    assert.equal((await one(`select count(*)::int n from ${t} where music_id=$1`, [m])).n, 0, t);
  }
});

test('claim: concurrent workers on separate connections never receive the same job (SKIP LOCKED)', { skip }, async () => {
  await q('delete from music_classification_jobs');
  const ids = await addMusic(60);
  for (const id of ids) await q('insert into music_classification_jobs(music_id, priority) values ($1, $2)', [id, id === ids[0] ? 99 : 0]);
  const workers = await Promise.all([newClient(), newClient(), newClient(), newClient()]);
  try {
    const batches = await Promise.all(workers.map((w, i) => w.query('select * from classification_claim_jobs($1, $2)', [20, `w${i}`])));
    const claimed = batches.flatMap((b) => b.rows);
    assert.equal(claimed.length, 60); assert.equal(new Set(claimed.map((r) => r.id)).size, 60, 'no job claimed twice');
    assert.ok(claimed.every((r) => r.status === 'processing' && r.attempts === 1 && r.locked_by && r.started_at));
    assert.equal((await one("select count(*)::int n from classification_claim_jobs(10,'x')")).n, 0, 'nothing left');
  } finally { await Promise.all(workers.map((w) => w.end())); }
});

test('claim honours priority and next_retry_at', { skip }, async () => {
  await q('delete from music_classification_jobs');
  const [a, b, c2] = await addMusic(3);
  await q('insert into music_classification_jobs(music_id, priority) values ($1, 0)', [a]);
  await q('insert into music_classification_jobs(music_id, priority) values ($1, 10)', [b]);
  await q("insert into music_classification_jobs(music_id, priority, next_retry_at) values ($1, 50, now() + interval '1 hour')", [c2]);
  const r = await q("select * from classification_claim_jobs(5,'w')");
  assert.deepEqual(r.rows.map((x) => x.music_id), [b, a], 'highest priority first; a future retry is not due');
});

test('stale recovery re-queues orphaned jobs and dead-letters exhausted ones', { skip }, async () => {
  await q('delete from music_classification_jobs');
  const [a, b, fresh] = await addMusic(3);
  await q("insert into music_classification_jobs(music_id,status,attempts,max_attempts,locked_by,locked_at) values ($1,'processing',1,5,'dead',now()-interval '1 hour')", [a]);
  await q("insert into music_classification_jobs(music_id,status,attempts,max_attempts,locked_by,locked_at) values ($1,'processing',5,5,'dead',now()-interval '1 hour')", [b]);
  await q("insert into music_classification_jobs(music_id,status,attempts,max_attempts,locked_by,locked_at) values ($1,'processing',1,5,'alive',now())", [fresh]);
  assert.equal((await one('select classification_recover_stale(300) n')).n, 2);
  const st = Object.fromEntries((await q('select music_id, status, dead_lettered_at, locked_by from music_classification_jobs')).rows.map((r) => [r.music_id, r]));
  assert.equal(st[a].status, 'pending'); assert.equal(st[a].locked_by, null);
  assert.equal(st[b].status, 'failed'); assert.ok(st[b].dead_lettered_at);
  assert.equal(st[fresh].status, 'processing');
});

test('backfill candidates: missing metadata, legacy-only, partial, complete, old version, non-music, open job; keyset pagination covers everything once', { skip }, async () => {
  await q('delete from media_items'); // cascades
  const [none, partial, complete, oldVer, openJob] = await addMusic(5);
  const [story] = await addMusic(1, 'audio_story');
  const req = ['genre', 'language', 'vocal', 'version'];
  await q(`insert into music_classification_metadata(music_id, classification_version, dimension_status) values
    ($1, 1, '{"genre":"approved"}'),
    ($2, 1, '{"genre":"approved","language":"approved","vocal":"unknown","version":"approved"}'),
    ($3, 0, '{"genre":"approved","language":"approved","vocal":"approved","version":"approved"}')`, [partial, complete, oldVer]);
  await q("insert into music_track_labels(music_id,label_id,confidence,source,status) values ($1,$2,0.9,'t','provisional')", [partial, await labelId('language', 'hindi')]);
  await q('insert into music_classification_jobs(music_id) values ($1)', [openJob]);

  const cands = async (after, limit, minV = 0) => (await q('select id from classification_backfill_candidates($1,$2,$3,$4)', [after, limit, req, minV])).rows.map((r) => r.id);
  const all = await cands(null, 100);
  assert.ok(all.includes(none), 'no metadata at all');
  assert.ok(all.includes(partial), 'vocal never attempted and has no label');
  assert.ok(!all.includes(complete), 'every required dimension attempted');
  assert.ok(!all.includes(story), 'non-music excluded');
  assert.ok(!all.includes(openJob), 'already queued');
  assert.ok(!all.includes(oldVer), 'dimension_status is complete and min_version=0');
  assert.ok((await cands(null, 100, 1)).includes(oldVer), 'older engine version re-processed when asked');
  assert.ok((await cands(null, 100, 2)).includes(complete), 'bumping minVersion re-processes everything');

  const seen = []; let cursor = null;
  for (;;) { const page = await cands(cursor, 2, 99); if (!page.length) break; seen.push(...page); cursor = page[page.length - 1]; }
  const expected = (await q("select m.id from media_items m where type='music' and not exists (select 1 from music_classification_jobs j where j.music_id=m.id and j.status in ('pending','processing')) order by id")).rows.map((r) => r.id);
  assert.deepEqual(seen, expected);
});

test('backfill candidates scale: 5,000 tracks paged 100 at a time', { skip }, async () => {
  await q('delete from media_items');
  await q("insert into media_items(type) select 'music' from generate_series(1,5000)");
  let cursor = null; let total = 0; let pages = 0;
  for (;;) {
    const r = (await q('select id from classification_backfill_candidates($1,100,$2,0)', [cursor, ['genre']])).rows;
    if (!r.length) break; total += r.length; pages++; cursor = r[r.length - 1].id;
  }
  assert.equal(total, 5000); assert.equal(pages, 50);
});

test('only one backfill can be active; finished ones do not block a new one', { skip }, async () => {
  await q('delete from music_classification_backfill');
  await q("insert into music_classification_backfill(status) values ('running')");
  await assert.rejects(q("insert into music_classification_backfill(status) values ('paused')"), /uq_mcb_single_active/);
  await q("update music_classification_backfill set status='completed'");
  await q("insert into music_classification_backfill(status) values ('running')");
});

test('provider counters and the dashboard stats function', { skip }, async () => {
  await q('delete from media_items'); await q('delete from music_provider_stats'); await q('delete from music_classification_jobs');
  const [a, b, c3, d] = await addMusic(4);
  await q("insert into music_classification_metadata(music_id, overall_status) values ($1,'complete'),($2,'partial'),($3,'needs_review'),($4,'failed')", [a, b, c3, d]);
  await q("insert into music_classification_jobs(music_id,status,started_at,completed_at) values ($1,'completed',now()-interval '4 seconds',now())", [a]);
  await q("insert into music_classification_jobs(music_id,status) values ($1,'pending')", [b]);
  for (const o of ['ok', 'ok', 'failed', 'rate_limited']) await q("select classification_record_provider_call('musicbrainz', $1, 'err')", [o]);
  const s = (await one('select classification_stats() s')).s;
  assert.equal(s.total_tracks, 4); assert.equal(s.complete, 1); assert.equal(s.partial, 1); assert.equal(s.needs_review, 1); assert.equal(s.failed, 1);
  assert.equal(s.jobs.completed, 1); assert.equal(s.jobs.pending, 1);
  assert.ok(Math.abs(s.avg_classification_seconds - 4) < 0.5);
  assert.deepEqual([s.providers.musicbrainz.ok, s.providers.musicbrainz.failed, s.providers.musicbrainz.rate_limited], [2, 1, 1]);
  assert.equal(s.providers.musicbrainz.last_error, 'err');
});

test('down migration removes everything it added and leaves media_items untouched; up again works', { skip }, async () => {
  const before = (await one('select count(*)::int n from media_items')).n;
  await q(SQL('migration_music_classification_down.sql'));
  const left = (await q("select table_name from information_schema.tables where table_schema=$1 and table_name like 'music\\_%'", [SCHEMA])).rows;
  assert.deepEqual(left, []);
  assert.equal((await one("select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=$1 and proname like 'classification\\_%'", [SCHEMA])).n, 0);
  assert.equal((await one('select count(*)::int n from media_items')).n, before);
  await q(SQL('migration_music_classification.sql')); await q(SQL('seed_music_labels.sql'));
  assert.ok((await one('select count(*)::int n from music_labels')).n > 100);
});
