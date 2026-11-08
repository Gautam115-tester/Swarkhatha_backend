'use strict';
/**
 * Test harness for the classification system: the project's in-memory Supabase
 * double (test/fakeSupabase.js) plus the new tables and the four SQL functions the
 * queue/backfill call via rpc(). The SQL originals are verified against real
 * Postgres in test/classification/sql.integration.test.js; the JS versions here
 * mirror their documented behaviour so the engine/queue/worker logic can be tested fast.
 */
const { create } = require('../fakeSupabase');
const { load } = require('../../lib/classification/config');
const { createService } = require('../../lib/classification/service');
const { createStore } = require('../../lib/classification/store');

const NEW_TABLES = ['music_labels', 'music_track_labels', 'music_classification_jobs', 'music_classification_metadata',
  'music_classification_sources', 'music_provider_cache', 'music_provider_stats', 'music_classification_backfill', 'lyrics_cache', 'albums'];

function makeDb() {
  const fake = create();
  for (const t of NEW_TABLES) fake.db[t] ||= [];
  const { db } = fake;

  // Partial unique index uq_mcj_open_job + a few unique constraints the real schema enforces.
  const origFrom = fake.from;
  fake.from = (table) => {
    const b = origFrom(table);
    if (table === 'music_classification_jobs') {
      const origThen = b.then;
      let isInsert = false; let payload;
      const origInsert = b.insert;
      b.insert = (p) => { isInsert = true; payload = p; return origInsert(p); };
      b.then = (res, rej) => {
        if (isInsert && db.music_classification_jobs.some((j) => j.music_id === payload.music_id && ['pending', 'processing'].includes(j.status))) {
          return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "uq_mcj_open_job"' } }).then(res, rej);
        }
        if (isInsert) { // column defaults the real table has
          Object.assign(payload, { attempts: 0, max_attempts: 5, ...payload, created_at: new Date().toISOString() });
          payload.status ||= 'pending';
        }
        return origThen(res, rej);
      };
    }
    if (table === 'music_track_labels') {
      const origInsert = b.insert; const origThen = b.then; let ins = false; let p;
      b.insert = (x) => { ins = true; p = x; return origInsert(x); };
      b.then = (res, rej) => {
        if (ins && db.music_track_labels.some((r) => r.music_id === p.music_id && r.label_id === p.label_id)) {
          return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }).then(res, rej);
        }
        return origThen(res, rej);
      };
    }
    if (table === 'music_classification_metadata' || table === 'music_classification_sources') {
      // metadata has music_id as its primary key
      const origInsert = b.insert; const origThen = b.then; let ins = false; let p;
      b.insert = (x) => { ins = true; p = x; return origInsert(x); };
      b.then = (res, rej) => {
        if (ins && table === 'music_classification_metadata' && db[table].some((r) => r.music_id === p.music_id)) {
          return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } }).then(res, rej);
        }
        return origThen(res, rej);
      };
    }
    if (table === 'music_classification_backfill') {
      const origInsert = b.insert; const origThen = b.then; let ins = false; let p;
      b.insert = (x) => { ins = true; p = x; return origInsert(x); };
      b.then = (res, rej) => {
        if (ins && db[table].some((r) => ['running', 'paused'].includes(r.status))) {
          return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "uq_mcb_single_active"' } }).then(res, rej);
        }
        if (ins) { p.stats ||= {}; p.started_at = new Date().toISOString(); }
        return origThen(res, rej);
      };
    }
    return b;
  };

  fake.rpc = async (name, args = {}) => {
    const jobs = db.music_classification_jobs;
    if (name === 'classification_claim_jobs') {
      const due = jobs.filter((j) => j.status === 'pending' && (!j.next_retry_at || new Date(j.next_retry_at) <= new Date()))
        .sort((a, z) => (z.priority || 0) - (a.priority || 0) || String(a.created_at).localeCompare(String(z.created_at))).slice(0, args.p_limit);
      due.forEach((j) => Object.assign(j, { status: 'processing', locked_by: args.p_worker, locked_at: new Date().toISOString(), attempts: (j.attempts || 0) + 1 }));
      return { data: due.map((j) => ({ ...j })), error: null };
    }
    if (name === 'classification_recover_stale') {
      let n = 0;
      for (const j of jobs) {
        if (j.status === 'processing' && new Date(j.locked_at).getTime() < Date.now() - args.p_lock_seconds * 1000) {
          n++; Object.assign(j, j.attempts >= j.max_attempts ? { status: 'failed', dead_lettered_at: new Date().toISOString() } : { status: 'pending' }, { locked_by: null, locked_at: null });
        }
      }
      return { data: n, error: null };
    }
    if (name === 'classification_backfill_candidates') {
      const rows = db.media_items.filter((m) => m.type === 'music' && (!args.p_after || m.id > args.p_after)
        && !jobs.some((j) => j.music_id === m.id && ['pending', 'processing'].includes(j.status)))
        .filter((m) => {
          const cm = db.music_classification_metadata.find((x) => x.music_id === m.id);
          if (!cm || cm.classification_version < args.p_min_version) return true;
          return args.p_required.some((d) => !(d in (cm.dimension_status || {})) && !db.music_track_labels.some((tl) => tl.music_id === m.id
            && ['approved', 'provisional'].includes(tl.status) && db.music_labels.find((l) => l.id === tl.label_id)?.dimension === d));
        }).sort((a, z) => (a.id < z.id ? -1 : 1)).slice(0, args.p_limit);
      return { data: rows.map((r) => ({ id: r.id })), error: null };
    }
    if (name === 'classification_record_provider_call') return { data: null, error: null };
    if (name === 'classification_stats') {
      const by = (s) => db.music_classification_metadata.filter((m) => m.overall_status === s).length;
      const jobsAgg = {}; jobs.forEach((j) => { jobsAgg[j.status] = (jobsAgg[j.status] || 0) + 1; });
      return { data: { total_tracks: db.media_items.filter((m) => m.type === 'music').length, complete: by('complete'), partial: by('partial'), needs_review: by('needs_review'), failed: by('failed'), jobs: jobsAgg, providers: {} }, error: null };
    }
    return { data: null, error: { message: `unknown rpc ${name}` } };
  };
  return fake;
}

async function seededService({ config, providers, http, llmClassify, audioLink, env = {} } = {}) {
  const fake = makeDb();
  const cfg = config || load({ CLASSIFICATION_BACKOFF_BASE_MS: '10', ...env });
  const log = () => {};
  const svc = createService({ supabase: fake, config: cfg, http, llmClassify, audioLink, providers: providers || [], log });
  await svc.store.ensureTaxonomy();
  return { fake, svc, db: fake.db, cfg };
}

let n = 0;
function addTrack(db, fields = {}) {
  n++;
  const row = { id: `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`, type: 'music', title: `Track ${n}`, artist_or_narrator: null, album_or_series: null, album_id: null,
    duration_seconds: 240, category: null, content_label_id: null, storage_path: `t${n}.mp3`, ...fields };
  db.media_items.push(row);
  return row;
}

/** a provider double: returns canned lookup results */
const stubProvider = (name, lookup, configured = true) => ({ name, group: name, isConfigured: () => configured, lookup });

module.exports = { makeDb, seededService, addTrack, stubProvider, createStore };
