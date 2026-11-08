'use strict';

/**
 * All tunables for the classification engine, read from environment variables.
 * `load(env)` is a pure function so tests can build a config without touching
 * process.env. See CLASSIFICATION.md for the full variable table.
 *
 * Provider credentials are NEVER logged and never leave this process: `summary()`
 * only reports whether each one is configured.
 */

// Bump when the engine's decision logic changes in a way that should re-process
// old tracks (the backfill's `minVersion` option compares against it).
const CLASSIFICATION_VERSION = 1;

const num = (v, d) => { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) ? n : d; };
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|on|yes)$/i.test(String(v)));
const list = (v, d) => (v === undefined || v === '' ? d : String(v).split(',').map((s) => s.trim()).filter(Boolean));

function load(env = process.env) {
  return {
    version: CLASSIFICATION_VERSION,

    // Confidence thresholds (per label, never per song).
    thresholds: {
      approve: num(env.CLASSIFY_THRESHOLD_APPROVE, 0.95),         // >= : approved automatically
      supported: num(env.CLASSIFY_THRESHOLD_SUPPORTED, 0.85),     // >= : approved only with sufficient supporting evidence
      provisional: num(env.CLASSIFY_THRESHOLD_PROVISIONAL, 0.70), // >= : saved as provisional
      review: num(env.CLASSIFY_THRESHOLD_REVIEW, 0.50)            // >= : saved as needs_review; below: not stored
    },

    // A track counts as "fully classified" once each of these has an approved label.
    requiredDimensions: list(env.CLASSIFY_REQUIRED_DIMENSIONS, ['genre', 'language', 'vocal', 'version']),

    // Recording matching.
    match: {
      minScore: num(env.CLASSIFY_MATCH_MIN_SCORE, 0.82),
      durationToleranceSec: num(env.CLASSIFY_DURATION_TOLERANCE_SEC, 3),
      durationRejectSec: num(env.CLASSIFY_DURATION_REJECT_SEC, 10)
    },

    // Contradiction penalty: conf *= 1 - penalty * (best competing label's confidence).
    competitorPenalty: num(env.CLASSIFY_COMPETITOR_PENALTY, 0.6),

    // Worker / queue.
    worker: {
      enabled: bool(env.CLASSIFICATION_WORKER_ENABLED, true),
      concurrency: Math.max(1, num(env.CLASSIFICATION_CONCURRENCY, 2)),
      pollMs: num(env.CLASSIFICATION_POLL_MS, 5000),
      jobTimeoutMs: num(env.CLASSIFICATION_JOB_TIMEOUT_MS, 120000),
      lockTimeoutMs: num(env.CLASSIFICATION_LOCK_TIMEOUT_MS, 300000),
      maxAttempts: num(env.CLASSIFICATION_MAX_ATTEMPTS, 5),
      backoffBaseMs: num(env.CLASSIFICATION_BACKOFF_BASE_MS, 30000),
      backoffMaxMs: num(env.CLASSIFICATION_BACKOFF_MAX_MS, 6 * 3600 * 1000),
      shutdownGraceMs: num(env.CLASSIFICATION_SHUTDOWN_GRACE_MS, 20000),
      workerId: env.CLASSIFICATION_WORKER_ID || `w-${process.pid}`
    },

    // Historical backfill.
    backfill: {
      batchSize: Math.min(100, Math.max(1, num(env.CLASSIFICATION_BACKFILL_BATCH, 50))),
      // Don't enqueue another batch while this many jobs are already waiting.
      maxPending: num(env.CLASSIFICATION_BACKFILL_MAX_PENDING, 200)
    },

    // External-metadata cache lifetime (positive and negative answers).
    cache: {
      ttlMs: num(env.CLASSIFY_CACHE_TTL_DAYS, 30) * 86400000,
      negativeTtlMs: num(env.CLASSIFY_NEGATIVE_CACHE_TTL_DAYS, 3) * 86400000,
      memoryEntries: num(env.CLASSIFY_CACHE_MEMORY_ENTRIES, 2000)
    },

    providers: {
      // Order matters only for logging; they run concurrently.
      timeoutMs: num(env.CLASSIFY_PROVIDER_TIMEOUT_MS, 10000),
      breakerFailures: num(env.CLASSIFY_BREAKER_FAILURES, 5),
      breakerCooldownMs: num(env.CLASSIFY_BREAKER_COOLDOWN_MS, 120000),

      musicbrainz: {
        enabled: bool(env.MUSICBRAINZ_ENABLED, true),            // keyless; only a contact in the User-Agent is required
        baseUrl: env.MUSICBRAINZ_BASE_URL || 'https://musicbrainz.org/ws/2',
        contact: env.MUSICBRAINZ_CONTACT || '',                   // e-mail or URL; MusicBrainz blocks anonymous clients
        minIntervalMs: num(env.MUSICBRAINZ_MIN_INTERVAL_MS, 1100), // their documented limit is 1 request/second
        lookupArtists: bool(env.MUSICBRAINZ_LOOKUP_ARTISTS, true)  // extra call per credited artist, used only as a vocal-gender hint
      },
      spotify: {
        clientId: env.SPOTIFY_CLIENT_ID || '',
        clientSecret: env.SPOTIFY_CLIENT_SECRET || '',
        enabled: bool(env.SPOTIFY_ENABLED, true),
        baseUrl: env.SPOTIFY_BASE_URL || 'https://api.spotify.com/v1',
        tokenUrl: env.SPOTIFY_TOKEN_URL || 'https://accounts.spotify.com/api/token',
        market: env.SPOTIFY_MARKET || 'IN',
        minIntervalMs: num(env.SPOTIFY_MIN_INTERVAL_MS, 250)
      },
      lastfm: {
        apiKey: env.LASTFM_API_KEY || '',
        enabled: bool(env.LASTFM_ENABLED, true),
        baseUrl: env.LASTFM_BASE_URL || 'https://ws.audioscrobbler.com/2.0/',
        minIntervalMs: num(env.LASTFM_MIN_INTERVAL_MS, 250),
        minTagCount: num(env.LASTFM_MIN_TAG_COUNT, 20)           // Last.fm tag counts are normalised 0-100
      },
      llm: {
        // Text-only inference through the existing Groq pool: only title/artist/album are sent, never audio.
        enabled: bool(env.CLASSIFY_LLM_ENABLED, true)
      },
      audio: {
        // Off by default. Sending audio (even a short-lived link) to any analyzer is a privacy decision:
        // BOTH switches must be on, and the URL should point at a service you operate.
        enabled: bool(env.AUDIO_ANALYSIS_ENABLED, false),
        consent: bool(env.AUDIO_ANALYSIS_CONSENT, false),
        url: env.AUDIO_ANALYZER_URL || '',
        token: env.AUDIO_ANALYZER_TOKEN || '',
        timeoutMs: num(env.AUDIO_ANALYZER_TIMEOUT_MS, 90000),
        minIntervalMs: num(env.AUDIO_ANALYZER_MIN_INTERVAL_MS, 0),
        linkTtlSeconds: num(env.AUDIO_ANALYZER_LINK_TTL_SECONDS, 900)
      }
    }
  };
}

function isConfigured(cfg, provider) {
  const p = cfg.providers[provider];
  if (!p || p.enabled === false) return false;
  switch (provider) {
    case 'musicbrainz': return Boolean(p.contact);
    case 'spotify': return Boolean(p.clientId && p.clientSecret);
    case 'lastfm': return Boolean(p.apiKey);
    case 'llm': return true;
    case 'audio': return Boolean(p.enabled && p.consent && p.url);
    default: return false;
  }
}

// Safe-to-log / safe-to-return description (no secrets).
function summary(cfg) {
  const names = ['musicbrainz', 'spotify', 'lastfm', 'llm', 'audio'];
  return {
    version: cfg.version,
    thresholds: cfg.thresholds,
    requiredDimensions: cfg.requiredDimensions,
    providers: Object.fromEntries(names.map((n) => [n, { configured: isConfigured(cfg, n) }])),
    worker: { enabled: cfg.worker.enabled, concurrency: cfg.worker.concurrency, pollMs: cfg.worker.pollMs, maxAttempts: cfg.worker.maxAttempts },
    backfill: cfg.backfill
  };
}

module.exports = { load, isConfigured, summary, CLASSIFICATION_VERSION };
