'use strict';

/**
 * Queue worker: polls for due jobs, runs the engine on each with a timeout, and
 * records the outcome. Supports concurrency limits, exponential-backoff retries,
 * dead-lettering, recovery of jobs orphaned by a crash/restart, graceful shutdown,
 * and driving the backfill (one batch per poll while it is running).
 *
 * Two ways to run it: start()/stop() as a long-lived loop (server.js, the CLI
 * `worker` command), or runUntilIdle() for a bounded burst (the cron endpoint,
 * so a sleeping Render instance can still drain the queue when pinged).
 */
const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

function createWorker({ queue, engine, backfill, config, log = () => {}, sleep = sleepDefault }) {
  const { worker: wc } = config;
  const active = new Map(); // jobId -> { job, promise }
  let running = false;
  let timer = null;
  let lastRecover = 0;
  let lastPollErr = { message: null, at: 0 };
  const counters = { processed: 0, completed: 0, retried: 0, failed: 0, cancelled: 0, lastError: null, lastJobAt: null };

  function withJobTimeout(promise, ms) {
    let t;
    const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`job timed out after ${ms}ms`)), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
  }

  async function handleError(job, err) {
    counters.lastError = err.message;
    log('error', 'job_error', { jobId: job.id, trackId: job.music_id, attempts: job.attempts, message: err.message });
    if (job.attempts < job.max_attempts) { counters.retried++; await queue.retryLater(job, err.message); }
    else { counters.failed++; await queue.deadLetter(job, err.message); }
  }

  async function processJob(job) {
    const startedAt = Date.now();
    let res;
    try {
      res = await withJobTimeout(engine.classifyTrack(job.music_id, { dimensions: job.dimensions }), wc.jobTimeoutMs);
    } catch (e) {
      return handleError(job, e);
    }
    counters.processed++;
    counters.lastJobAt = new Date().toISOString();
    const summary = {
      outcome: res.outcome, overallStatus: res.overallStatus || null, labels: res.labels?.length || 0,
      dimensionStatus: res.dimensionStatus || null, providerErrors: res.providerErrors || [], tookMs: Date.now() - startedAt
    };
    try {
      if (res.outcome === 'cancelled') { counters.cancelled++; return await queue.cancel(job, res.reason); }
      const errs = (res.providerErrors || []).map((e) => `${e.provider}: ${e.kind}`).join(', ');
      if (res.retry && job.attempts < job.max_attempts) {
        counters.retried++;
        const wait = Math.max(0, ...(res.providerErrors || []).map((e) => e.retryAfterMs || 0));
        return await queue.retryLater(job, `incomplete, will retry (${errs})`, wait);
      }
      if (res.outcome === 'failed') {
        if (job.attempts < job.max_attempts) { counters.retried++; return await queue.retryLater(job, `all providers failed (${errs})`); }
        counters.failed++;
        return await queue.deadLetter(job, `all providers failed after ${job.attempts} attempts (${errs})`);
      }
      counters.completed++;
      return await queue.complete(job, res.outcome, summary);
    } catch (e) {
      // The classification itself is saved; only the job bookkeeping failed. The lock expires and the job is recovered.
      log('error', 'job_bookkeeping_failed', { jobId: job.id, message: e.message });
    }
  }

  function launch(job) {
    const promise = processJob(job).catch((e) => log('error', 'job_crashed', { jobId: job.id, message: e.message })).finally(() => active.delete(job.id));
    active.set(job.id, { job, promise });
    return promise;
  }

  async function maintenance() {
    if (Date.now() - lastRecover > 60000) {
      lastRecover = Date.now();
      const n = await queue.recoverStale();
      if (n) log('warn', 'recovered_stale_jobs', { count: n });
    }
    if (backfill) {
      const r = await backfill.tick();
      if (r.ran && !r.done) log('info', 'backfill_batch', { scanned: r.scanned, enqueued: r.enqueued });
    }
  }

  /** Claims up to the free slots and starts them. Returns how many were started. */
  async function pollOnce() {
    await maintenance().catch((e) => { if (e.message !== lastPollErr.message) log('error', 'maintenance_failed', { message: e.message }); });
    const free = wc.concurrency - active.size;
    if (free <= 0) return 0;
    const jobs = await queue.claim(free, wc.workerId);
    jobs.forEach(launch);
    return jobs.length;
  }

  /** Bounded burst: keeps claiming until nothing is due, or the deadline / job cap is hit. */
  async function runUntilIdle({ deadlineMs = 25000, maxJobs = Infinity } = {}) {
    const deadline = Date.now() + deadlineMs;
    let started = 0;
    await maintenance().catch((e) => log('error', 'maintenance_failed', { message: e.message }));
    while (Date.now() < deadline && started < maxJobs) {
      const free = Math.min(wc.concurrency - active.size, maxJobs - started);
      if (free > 0) {
        const jobs = await queue.claim(free, wc.workerId);
        jobs.forEach(launch);
        started += jobs.length;
        if (!jobs.length && !active.size) break;
      }
      if (active.size) await Promise.race([...active.values()].map((a) => a.promise));
      else await sleep(0);
    }
    await Promise.all([...active.values()].map((a) => a.promise));
    return { started, ...counters };
  }

  function start() {
    if (running) return;
    running = true;
    log('info', 'worker_started', { workerId: wc.workerId, concurrency: wc.concurrency, pollMs: wc.pollMs });
    const loop = async () => {
      if (!running) return;
      let started = 0;
      try { started = await pollOnce(); }
      catch (e) {
        counters.lastError = e.message;
        // Same failure (database down, migration not applied yet): say it once a minute, not every poll.
        if (e.message !== lastPollErr.message || Date.now() - lastPollErr.at > 60000) { lastPollErr = { message: e.message, at: Date.now() }; log('error', 'poll_failed', { message: e.message }); }
      }
      if (!running) return;
      // Busy: poll again soon so freed slots refill; idle: wait the full interval.
      timer = setTimeout(loop, started > 0 ? 250 : wc.pollMs);
      timer.unref?.();
    };
    loop();
  }

  /** Stops claiming, waits up to the grace period for running jobs, hands the rest back. */
  async function stop() {
    running = false;
    clearTimeout(timer);
    const pending = [...active.values()];
    if (!pending.length) return { released: 0 };
    const done = Promise.all(pending.map((a) => a.promise));
    const timedOut = await Promise.race([done.then(() => false), sleep(wc.shutdownGraceMs).then(() => true)]);
    if (!timedOut) return { released: 0 };
    let released = 0;
    for (const a of active.values()) { await queue.release(a.job).then(() => { released++; }, () => {}); }
    log('warn', 'worker_stopped_with_jobs_released', { released });
    return { released };
  }

  return { start, stop, pollOnce, runUntilIdle, counters, get activeCount() { return active.size; }, get running() { return running; } };
}

module.exports = { createWorker };
