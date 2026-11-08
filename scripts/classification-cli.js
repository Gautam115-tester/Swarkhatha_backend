#!/usr/bin/env node
'use strict';
/**
 * Operations CLI for the music classification system. Uses the same service as the API,
 * so it needs the same environment (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TOKEN_ENC_KEY, ...).
 *
 *   node scripts/classification-cli.js seed-taxonomy
 *   node scripts/classification-cli.js worker                    long-running worker (also drives a running backfill)
 *   node scripts/classification-cli.js run-once [--seconds 60]   drain the queue for a bounded time, then exit
 *   node scripts/classification-cli.js backfill start [--dry-run] [--batch 50] [--limit N] [--min-version N] [--dims genre,language]
 *   node scripts/classification-cli.js backfill pause|resume|cancel|status
 *   node scripts/classification-cli.js retry-failed
 *   node scripts/classification-cli.js reclassify <trackId> [<trackId> ...]
 *   node scripts/classification-cli.js reclassify --all
 *   node scripts/classification-cli.js classify <trackId> [--dry-run]   run the engine right now, in this process
 *   node scripts/classification-cli.js status
 *   node scripts/classification-cli.js track <trackId>
 */
require('dotenv').config();

function parseArgs(argv) {
  const flags = {}; const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = true;
    } else rest.push(a);
  }
  return { flags, rest };
}
const print = (o) => console.log(JSON.stringify(o, null, 2));

async function main() {
  const { flags, rest } = parseArgs(process.argv.slice(2));
  const [cmd, sub, ...more] = rest;
  const svc = require('../lib/classification/service').getService();

  switch (cmd) {
    case 'seed-taxonomy': return print({ inserted: await svc.store.ensureTaxonomy() });

    case 'worker': {
      await svc.store.ensureTaxonomy();
      svc.worker.start();
      const stop = async () => { console.log('shutting down...'); await svc.stopWorker(); process.exit(0); };
      process.on('SIGTERM', stop); process.on('SIGINT', stop);
      return new Promise(() => {}); // run until signalled
    }

    case 'run-once': {
      await svc.store.ensureTaxonomy();
      return print(await svc.worker.runUntilIdle({ deadlineMs: (Number(flags.seconds) || 60) * 1000 }));
    }

    case 'backfill': {
      switch (sub) {
        case 'start': {
          const dims = typeof flags.dims === 'string' ? flags.dims.split(',') : undefined;
          return print(await svc.backfill.start({ batchSize: flags.batch, dryRun: Boolean(flags['dry-run']), limit: flags.limit, minVersion: flags['min-version'], requiredDimensions: dims }));
        }
        case 'pause': return print(await svc.backfill.pause());
        case 'resume': return print(await svc.backfill.resume());
        case 'cancel': return print(await svc.backfill.cancel());
        case 'status': return print(await svc.backfill.status());
        default: throw new Error('usage: backfill start|pause|resume|cancel|status');
      }
    }

    case 'retry-failed': return print(await svc.queue.retryFailed({ limit: Number(flags.limit) || 500 }));

    case 'reclassify': {
      if (flags.all) return print(await svc.reclassify({ all: true, limit: flags.limit }));
      const ids = [sub, ...more].filter(Boolean);
      if (!ids.length) throw new Error('usage: reclassify <trackId> [...] | --all');
      return print(await svc.reclassify({ ids }));
    }

    case 'classify': {
      if (!sub) throw new Error('usage: classify <trackId> [--dry-run]');
      await svc.store.ensureTaxonomy();
      return print(await svc.engine.classifyTrack(sub, { dryRun: Boolean(flags['dry-run']) }));
    }

    case 'status': return print(await svc.status());
    case 'track': if (!sub) throw new Error('usage: track <trackId>'); return print(await svc.trackDetail(sub));

    default:
      console.error('Unknown command. See the usage block at the top of scripts/classification-cli.js');
      process.exit(2);
  }
}

main().then(() => { if (!['worker'].includes(process.argv[2])) setTimeout(() => process.exit(0), 200); })
  .catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
