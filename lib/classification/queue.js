'use strict';

/**
 * Durable job queue on Postgres (table music_classification_jobs). Why not Redis/BullMQ:
 * the project already runs on Supabase and a free-tier Render instance that sleeps and
 * restarts, so jobs must survive the process. Postgres gives that for free:
 *   - one open job per track (partial unique index)  -> duplicate prevention
 *   - claim via FOR UPDATE SKIP LOCKED (RPC)         -> safe with several workers/instances
 *   - locked_at + stale recovery                     -> jobs survive a crashed worker
 *   - attempts / next_retry_at / dead_lettered_at    -> retry with exponential backoff, dead letters
 */
const PRIORITY = { manual: 20, upload: 10, retry: 5, reclassify: 5, backfill: 0 };
const isDup = (e) => e && (e.code === '23505' || /duplicate key/i.test(e.message || ''));
const check = (error, what) => { if (error) throw new Error(`${what}: ${error.message}`); };

function createQueue({ supabase, config, now = () => new Date(), random = Math.random }) {
  const iso = (d = now()) => d.toISOString();

  /** Idempotent. Returns { created, jobId? } -- created=false means an open job already exists. */
  async function enqueue(musicId, { reason = 'upload', dimensions = null, priority } = {}) {
    const { data, error } = await supabase.from('music_classification_jobs').insert({
      music_id: musicId, status: 'pending', reason, dimensions: dimensions && dimensions.length ? dimensions : null,
      priority: priority ?? PRIORITY[reason] ?? 0, max_attempts: config.worker.maxAttempts
    }).select('id').single();
    if (isDup(error)) return { created: false };
    check(error, 'enqueue classification job');
    return { created: true, jobId: data.id };
  }

  async function claim(limit, workerId) {
    if (limit <= 0) return [];
    const { data, error } = await supabase.rpc('classification_claim_jobs', { p_limit: limit, p_worker: workerId });
    check(error, 'claim jobs');
    return data || [];
  }

  async function recoverStale() {
    const { data, error } = await supabase.rpc('classification_recover_stale', { p_lock_seconds: Math.ceil(config.worker.lockTimeoutMs / 1000) });
    check(error, 'recover stale jobs');
    return Number(data) || 0;
  }

  function backoffMs(attempts, minMs = 0) {
    const { backoffBaseMs, backoffMaxMs } = config.worker;
    const exp = Math.min(backoffMaxMs, backoffBaseMs * 2 ** Math.max(0, attempts - 1));
    const jittered = exp * (0.8 + 0.4 * random());
    return Math.max(jittered, Math.min(minMs, backoffMaxMs));
  }

  async function finish(jobId, patch) {
    const { error } = await supabase.from('music_classification_jobs').update({ locked_by: null, locked_at: null, updated_at: iso(), ...patch }).eq('id', jobId);
    check(error, 'update job');
  }

  const complete = (job, status, result) => finish(job.id, { status, completed_at: iso(), error_message: null, result: result || null, next_retry_at: null });
  const cancel = (job, reason) => finish(job.id, { status: 'cancelled', completed_at: iso(), error_message: reason || null });
  const retryLater = (job, message, minDelayMs = 0) =>
    finish(job.id, { status: 'pending', error_message: String(message).slice(0, 500), next_retry_at: iso(new Date(now().getTime() + backoffMs(job.attempts, minDelayMs))) });
  const deadLetter = (job, message) =>
    finish(job.id, { status: 'failed', error_message: String(message).slice(0, 500), completed_at: iso(), dead_lettered_at: iso() });
  // Graceful shutdown: hand a job back untouched (the attempt it used up is returned too).
  const release = (job) => finish(job.id, { status: 'pending', attempts: Math.max(0, job.attempts - 1), next_retry_at: null });

  /** Re-queues the tracks of failed (dead-lettered) jobs. Old failed rows are marked cancelled so they are not retried twice. */
  async function retryFailed({ limit = 500 } = {}) {
    const { data, error } = await supabase.from('music_classification_jobs').select('id, music_id').eq('status', 'failed').order('created_at', { ascending: false }).limit(limit);
    check(error, 'list failed jobs');
    const seen = new Set(); let requeued = 0; let skipped = 0;
    for (const j of data || []) {
      if (seen.has(j.music_id)) { await supabase.from('music_classification_jobs').update({ status: 'cancelled', error_message: 'superseded by a newer failed job', updated_at: iso() }).eq('id', j.id); continue; }
      seen.add(j.music_id);
      const r = await enqueue(j.music_id, { reason: 'retry' });
      if (r.created) { requeued++; await supabase.from('music_classification_jobs').update({ status: 'cancelled', error_message: 'superseded by retry', updated_at: iso() }).eq('id', j.id); } else skipped++;
    }
    return { requeued, skipped };
  }

  async function countByStatus(status) {
    const { count, error } = await supabase.from('music_classification_jobs').select('id', { count: 'exact', head: true }).eq('status', status);
    check(error, 'count jobs');
    return count || 0;
  }

  return { enqueue, claim, recoverStale, complete, cancel, retryLater, deadLetter, release, retryFailed, countByStatus, backoffMs, PRIORITY };
}

module.exports = { createQueue, PRIORITY };
