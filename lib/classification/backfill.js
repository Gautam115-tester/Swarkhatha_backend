'use strict';

/**
 * Historical backfill: walks media_items in keyset-pagination order (cursor = last id),
 * asks Postgres for the next batch of music tracks that still lack classification
 * (classification_backfill_candidates), and enqueues them. The same queue + engine
 * as uploads handle the actual work.
 *
 * State lives in music_classification_backfill, so it survives restarts and can be
 * paused/resumed/inspected. Never loads the library: one batch of 1..100 ids at a time.
 * Backpressure: no new batch while >= maxPending jobs are waiting.
 * Dry-run: walks and counts (and samples ids) but enqueues nothing.
 */
const check = (error, what) => { if (error) throw new Error(`${what}: ${error.message}`); };
const isDup = (e) => e && (e.code === '23505' || /duplicate key/i.test(e.message || ''));
const ACTIVE = ['running', 'paused'];

function createBackfill({ supabase, queue, config, log = () => {}, now = () => new Date() }) {
  const iso = () => now().toISOString();

  async function active() {
    const { data, error } = await supabase.from('music_classification_backfill').select('*').in('status', ACTIVE).limit(1);
    check(error, 'load backfill');
    return (data || [])[0] || null;
  }

  async function status() {
    const a = await active();
    if (a) return a;
    const { data, error } = await supabase.from('music_classification_backfill').select('*').order('started_at', { ascending: false }).limit(1);
    check(error, 'load backfill');
    return (data || [])[0] || null;
  }

  /**
   * options: { batchSize, dryRun, requiredDimensions, minVersion, reclassifyAll, limit }
   *  reclassifyAll -> every music track is a candidate again (minVersion = current + 1)
   */
  async function start(options = {}) {
    const batchSize = Math.min(100, Math.max(1, Number(options.batchSize) || config.backfill.batchSize));
    const required = options.requiredDimensions && options.requiredDimensions.length ? options.requiredDimensions : config.requiredDimensions;
    const minVersion = options.reclassifyAll ? config.version + 1 : Number(options.minVersion) || 0;
    const row = {
      status: 'running', dry_run: Boolean(options.dryRun), batch_size: batchSize,
      options: { requiredDimensions: required, minVersion, reclassifyAll: Boolean(options.reclassifyAll), limit: options.limit ? Number(options.limit) : null },
      cursor_id: null,
      stats: { scanned: 0, enqueued: 0, would_enqueue: 0, already_queued: 0, batches: 0, sample: [] }
    };
    const { data, error } = await supabase.from('music_classification_backfill').insert(row).select().single();
    if (isDup(error)) throw Object.assign(new Error('a backfill is already running or paused; resume, pause or cancel it first'), { status: 409 });
    check(error, 'start backfill');
    log('info', 'backfill_started', { id: data.id, dryRun: row.dry_run, batchSize, required, minVersion });
    return data;
  }

  async function transition(from, to) {
    const a = await active();
    if (!a) throw Object.assign(new Error('no active backfill'), { status: 404 });
    if (!from.includes(a.status)) throw Object.assign(new Error(`backfill is ${a.status}, cannot move to ${to}`), { status: 409 });
    const patch = { status: to, updated_at: iso(), ...(to === 'cancelled' ? { finished_at: iso() } : {}) };
    const { error } = await supabase.from('music_classification_backfill').update(patch).eq('id', a.id);
    check(error, 'update backfill');
    return { ...a, ...patch };
  }
  const pause = () => transition(['running'], 'paused');
  const resume = () => transition(['paused'], 'running');
  const cancel = () => transition(['running', 'paused'], 'cancelled');

  /** One batch. Returns { ran, done?, enqueued, scanned } -- ran=false when idle/paused/backpressured. */
  async function tick() {
    const run = await active();
    if (!run || run.status !== 'running') return { ran: false, reason: run ? 'paused' : 'no active backfill' };

    if (!run.dry_run && await queue.countByStatus('pending') >= config.backfill.maxPending) return { ran: false, reason: 'queue is full (backpressure)' };

    const opts = run.options || {};
    const stats = { ...run.stats };
    const remaining = opts.limit ? Math.max(0, opts.limit - stats.scanned) : run.batch_size;
    if (remaining === 0) return finishRun(run, stats);

    const { data, error } = await supabase.rpc('classification_backfill_candidates', {
      p_after: run.cursor_id || null, p_limit: Math.min(run.batch_size, remaining),
      p_required: opts.requiredDimensions || config.requiredDimensions, p_min_version: opts.minVersion || 0
    });
    check(error, 'find backfill candidates');
    const ids = (data || []).map((r) => (typeof r === 'string' ? r : r.id));
    if (!ids.length) return finishRun(run, stats);

    let enqueued = 0;
    for (const id of ids) {
      if (run.dry_run) { stats.would_enqueue++; if (stats.sample.length < 20) stats.sample.push(id); continue; }
      const r = await queue.enqueue(id, { reason: opts.reclassifyAll ? 'reclassify' : 'backfill' });
      if (r.created) { enqueued++; stats.enqueued++; } else stats.already_queued++;
    }
    stats.scanned += ids.length;
    stats.batches++;
    const { error: uerr } = await supabase.from('music_classification_backfill')
      .update({ cursor_id: ids[ids.length - 1], stats, updated_at: iso() }).eq('id', run.id).eq('status', 'running');
    check(uerr, 'save backfill progress');
    return { ran: true, scanned: ids.length, enqueued, done: false };
  }

  async function finishRun(run, stats) {
    await supabase.from('music_classification_backfill').update({ status: 'completed', stats, finished_at: iso(), updated_at: iso() }).eq('id', run.id);
    log('info', 'backfill_completed', { id: run.id, ...stats, sample: undefined });
    return { ran: true, scanned: 0, enqueued: 0, done: true };
  }

  return { start, pause, resume, cancel, status, tick, active };
}

module.exports = { createBackfill };
