const express = require('express');
const supabase = require('../lib/supabaseClient');
const { decrypt } = require('../lib/crypto');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const drime = require('../lib/drime');
const groq = require('../lib/groq');
const groqAccounts = require('../lib/groqAccountCache');

const router = express.Router();

// Single target now: romanized Hindi/"Hinglish" (spoken words phonetically
// in Latin script, NOT an English translation — see groq.js#buildHinglishPrompt).
// This used to also generate Hindi/English/Marathi/Bengali by translating
// the same Whisper pass into each of them; that was removed, so Hinglish is
// the only transcript this route produces. Kept as a 1-element array (not a
// single constant) because everything downstream — status storage, the
// GET /:mediaItemId response shape, the admin app's per-language rows —
// is already keyed by language, and this way none of that had to change.
const LANGUAGES = ['hi-en'];

function loadStorageCreds(account) {
  return JSON.parse(decrypt(account.credentials_enc));
}

function loadGroqKey(account) {
  return JSON.parse(decrypt(account.credentials_enc)).apiKey;
}

// Same "most free space" auto-pick used by POST /api/storage/upload.
// Transcript JSON files are tiny, but they still need to live in SOME
// Drime account — this reuses the existing audio_story/both pool rather
// than asking the admin to set up a separate one just for transcripts.
async function pickStorageAccount() {
  const { data: accounts } = await supabase
    .from('storage_accounts').select('*').eq('is_active', true).in('purpose', ['audio_story', 'both']);
  if (!accounts || accounts.length === 0) {
    throw new Error('No audio_story/both Drime storage account available to store transcripts');
  }
  return accounts.sort((a, b) => (b.last_known_free_bytes ?? 0) - (a.last_known_free_bytes ?? 0))[0];
}

async function uploadTranscriptJson({ mediaItem, language, segments }) {
  const account = await pickStorageAccount();
  const creds = loadStorageCreds(account);
  const buffer = Buffer.from(JSON.stringify({ mediaItemId: mediaItem.id, language, segments }), 'utf8');
  const uploaded = await drime.uploadFile({
    accessToken: creds.accessToken,
    buffer,
    fileName: `transcript_${mediaItem.id}_${language}.json`,
    mime: 'application/json',
    workspaceId: creds.workspaceId,
    folderId: creds.folderId
  });
  return {
    storageAccountId: account.id,
    storageFileId: uploaded.fileEntryId,
    storageHash: uploaded.hash,
    storagePath: uploaded.fileName
  };
}

async function setStatus(mediaItemId, language, fields) {
  await supabase.from('transcripts').upsert(
    { media_item_id: mediaItemId, language, updated_at: new Date().toISOString(), ...fields },
    { onConflict: 'media_item_id,language' }
  );
}

/* ------------------------------------------------------------------
 * 1) GENERATE  (admin only) — kicks off transcription + Hinglish
 *    transliteration for one episode. Responds immediately and runs the
 *    actual work in the background (matches the "don't await, let the
 *    response return immediately" pattern already used for the Drime
 *    live-storage monitor); the admin app polls GET /:mediaItemId for
 *    progress. One episode at a time per call — concurrency isn't needed
 *    at this project's scale, and it keeps Groq rate-limit handling simple.
 * ------------------------------------------------------------------ */
// A run in 'processing' for longer than this is treated as dead (server
// restarted mid-run, crashed before reaching a final status, etc.) rather
// than a real in-flight job -- otherwise one interrupted run could block
// every future retry on this episode forever.
const STALE_PROCESSING_MS = Number(process.env.TRANSCRIPT_STALE_PROCESSING_MS || 15 * 60 * 1000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Cap on how long a single generation run will wait out a pool-wide Groq
// 429 (see the wait-on-exhaustion comments below) before giving up. Kept
// comfortably under STALE_PROCESSING_MS so a run that's genuinely waiting
// on quota doesn't get mistaken for a dead/crashed one by the
// already-running check above.
const MAX_POOL_WAIT_MS = Number(process.env.GROQ_MAX_POOL_WAIT_MS || 10 * 60 * 1000);

router.post('/:mediaItemId/generate', requireAuth, requireAdmin, async (req, res) => {
  const { data: item } = await supabase.from('media_items').select('*').eq('id', req.params.mediaItemId).single();
  if (!item) return res.status(404).json({ error: 'Media item not found' });
  if (item.type !== 'audio_story') return res.status(400).json({ error: 'Transcription is only available for audio_story items' });
  if (!item.storage_hash) return res.status(500).json({ error: 'This episode has no storage_hash on file' });

  // Guard against a double-tap, a retried request from a flaky connection,
  // or an impatient extra click on "Re-generate" while a run is already in
  // flight -- previously nothing stopped a second full Whisper pass from
  // starting on the exact same audio, which quietly multiplies the ASPH
  // usage charged for what looked like one click.
  const { data: existing } = await supabase.from('transcripts').select('*').eq('media_item_id', item.id).in('language', LANGUAGES);
  const alreadyRunning = (existing || []).find(
    (t) => t.status === 'processing' && (Date.now() - new Date(t.updated_at).getTime()) < STALE_PROCESSING_MS
  );
  if (alreadyRunning) {
    return res.status(409).json({ error: 'A transcription run is already in progress for this episode — wait for it to finish before starting another.' });
  }

  for (const lang of LANGUAGES) {
    await setStatus(item.id, lang, { status: 'processing', error_message: null });
  }
  res.json({ ok: true, mediaItemId: item.id, languages: LANGUAGES });

  runGeneration(item).catch((e) => {
    console.error(`[transcripts] generation crashed for ${item.id}:`, e.message);
  });
});

async function runGeneration(item) {
  // 1) Pull the episode's own audio from whichever Drime account it's
  // already stored on (same account media_items.storage_account_id points
  // at for playback).
  const { data: audioAccount } = await supabase.from('storage_accounts').select('*').eq('id', item.storage_account_id).single();
  if (!audioAccount) {
    for (const lang of LANGUAGES) await setStatus(item.id, lang, { status: 'failed', error_message: 'Source storage account not found' });
    return;
  }

  let audioBuffer;
  try {
    const audioCreds = loadStorageCreds(audioAccount);
    const file = await drime.getFileBuffer({ accessToken: audioCreds.accessToken, hash: item.storage_hash });
    audioBuffer = file.buffer;
  } catch (e) {
    for (const lang of LANGUAGES) await setStatus(item.id, lang, { status: 'failed', error_message: `Could not read source audio: ${e.message}` });
    return;
  }

  // 2) Whisper pass — ONE original-language transcript with line timestamps.
  //
  // groq.transcribe() already retries a transient (5xx/network) failure a
  // few times against the SAME key (see MAX_ATTEMPTS in lib/groq.js). But
  // when the pool has several admin-added Groq accounts, a key that's
  // still failing after those retries (rate-limited, flaky, briefly
  // degraded on Groq's side, etc.) shouldn't sink the whole episode while
  // other keys sit idle — so this also rotates across up to 3 distinct
  // accounts before giving up.
  //
  // NOTE: if every account fails identically on the SAME episode (rather
  // than clearing up on a different key), the cause is almost always the
  // file itself, not the key — e.g. the unsupported-extension bug fixed in
  // lib/groq.js (see resolveGroqUpload there). Key rotation can't fix a
  // file-shaped problem, so a same-error-on-every-account result is the
  // signal to look at the file/format, not to add more Groq accounts.
  //
  // Was a flat 3 — but that meant a pool bigger than 3 (e.g. 6 admin-added
  // accounts, added specifically to spread Groq's per-account ASPH rate
  // limit across more org quotas) still only got 3 shots per generation
  // call, leaving the rest of the pool untried on a bad run. Defaults to
  // the size of the active pool now (capped at 8 so one call can't loop
  // forever if someone pools a huge number of keys); override via
  // GROQ_MAX_ACCOUNT_ATTEMPTS if needed.
  const activeGroqAccounts = await groqAccounts.listActive();
  // "+2" over the raw pool size leaves room for at least one wait-then-retry
  // cycle below even when the pool is tiny (e.g. exactly 1 account) --
  // without it, a pool of 1 got exactly 1 attempt total and could never
  // benefit from the wait-on-exhaustion logic at all.
  const MAX_ACCOUNT_ATTEMPTS = Number(
    process.env.GROQ_MAX_ACCOUNT_ATTEMPTS || Math.min(Math.max(activeGroqAccounts.length, 1) + 2, 10)
  );
  let groqAccount;
  let original;
  let lastErr;
  const triedAccountIds = new Set();
  for (let i = 0; i < MAX_ACCOUNT_ATTEMPTS; i++) {
    try {
      groqAccount = await groqAccounts.pick(); // least-recently-used, cooldown-aware
      triedAccountIds.add(groqAccount.id);

      original = await groq.transcribe({
        apiKey: loadGroqKey(groqAccount),
        buffer: audioBuffer,
        fileName: item.storage_path
      });
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      const msg = groq.extractErrorMessage(e);
      // For a 429, cool this account down for however long Groq itself
      // says it needs (parsed from the error body -- often minutes for an
      // ASPH-style limit) rather than a flat default, so pick() doesn't
      // hand it straight back out before its quota window has cleared.
      if (e.response?.status === 429 && groqAccount) {
        groqAccounts.markRateLimited(groqAccount.id, groq.parseRetryAfterMs(msg));
        // If that just put EVERY active account into cooldown (a small
        // pool, or several keys sharing one Groq org's ASPH quota), the
        // next attempt would just immediately hit the same 429 again.
        // Groq's error body already tells us exactly how long the quota
        // needs, so wait that out (capped) instead of burning through the
        // rest of the attempts on a pool that has no chance of succeeding
        // yet.
        const waitMs = await groqAccounts.msUntilAvailable();
        if (waitMs > 0) await sleep(Math.min(waitMs, MAX_POOL_WAIT_MS));
      }
      if (groqAccount) groqAccounts.markError(groqAccount.id, msg);
      // Keep trying a different account only for transient-looking
      // failures; a hard 4xx (e.g. unsupported file) will fail identically
      // on every key, so there's no point burning the whole pool on it.
      const status = e.response?.status;
      const looksAccountSpecific = !status || status === 429 || status >= 500;
      if (!looksAccountSpecific) break;
    }
  }
  if (lastErr) {
    const msg = groq.extractErrorMessage(lastErr);
    for (const lang of LANGUAGES) await setStatus(item.id, lang, { status: 'failed', error_message: `Transcription failed: ${msg}` });
    return;
  }

  if (original.segments.length === 0) {
    for (const lang of LANGUAGES) await setStatus(item.id, lang, { status: 'failed', error_message: 'Whisper returned no speech segments — is this file silent or corrupted?' });
    return;
  }

  // 3) Hinglish transliteration of the Whisper pass. (This used to loop
  // over 5 languages, translating into whichever ones weren't the detected
  // source; now there's just the one target, and it's always a
  // transliteration of the original — never a straight passthrough — so
  // is_source is always false here.)
  for (const lang of LANGUAGES) {
    // Tracks whichever account transliterateToHinglish() actually ends up
    // using -- it may rotate away from groqAccount (the Whisper-step
    // account) via getApiKey() below, so this starts as a reasonable
    // default and is reassigned every time getApiKey() is called.
    let hinglishAccount = groqAccount;
    try {
      const segments = await groq.transliterateToHinglish({
        // groq.js's transliterateToHinglish/transliterateBatchWithRetry
        // rotate across the account pool on a 429 by calling this for the
        // next account to try -- it must be a function returning
        // {account, apiKey}, NOT a bare apiKey string. Passing a bare
        // apiKey here (as this used to) is exactly what produced the
        // "getApiKey is not a function" crash: transliterateBatchWithRetry
        // calls `await getApiKey()`, and calling a string is a TypeError.
        getApiKey: async () => {
          hinglishAccount = await groqAccounts.pick();
          return { account: hinglishAccount, apiKey: loadGroqKey(hinglishAccount) };
        },
        // Same wait-on-exhaustion idea as the Whisper step above: if a
        // 429 just put every account in the pool into cooldown, wait for
        // the soonest one to clear (capped) before the retry loop's next
        // attempt, instead of immediately re-hitting the same 429.
        onRateLimited: async (account, e2) => {
          const rlMsg = groq.extractErrorMessage(e2);
          groqAccounts.markRateLimited(account.id, groq.parseRetryAfterMs(rlMsg));
          groqAccounts.markError(account.id, rlMsg);
          const waitMs = await groqAccounts.msUntilAvailable();
          if (waitMs > 0) await sleep(Math.min(waitMs, MAX_POOL_WAIT_MS));
        },
        segments: original.segments,
        accountAttempts: MAX_ACCOUNT_ATTEMPTS
      });

      const stored = await uploadTranscriptJson({ mediaItem: item, language: lang, segments });
      await setStatus(item.id, lang, {
        status: 'done',
        source_language: original.language || null,
        is_source: false,
        segment_count: segments.length,
        storage_account_id: stored.storageAccountId,
        storage_file_id: stored.storageFileId,
        storage_hash: stored.storageHash,
        storage_path: stored.storagePath,
        generated_by_account_id: hinglishAccount.id,
        error_message: null
      });
    } catch (e) {
      const msg = groq.extractErrorMessage(e);
      if (e.response?.status === 429 && hinglishAccount) groqAccounts.markRateLimited(hinglishAccount.id, groq.parseRetryAfterMs(msg));
      await setStatus(item.id, lang, { status: 'failed', error_message: msg });
    }
  }
}

/* ------------------------------------------------------------------
 * 2) STATUS  (any logged-in listener, and the admin app's progress poll)
 *    Per-language status only — no transcript content here.
 * ------------------------------------------------------------------ */
router.get('/:mediaItemId', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('transcripts').select('*').eq('media_item_id', req.params.mediaItemId);
  if (error) return res.status(500).json({ error: error.message });
  const byLanguage = Object.fromEntries((data || []).map((t) => [t.language, {
    status: t.status,
    isSource: t.is_source,
    segmentCount: t.segment_count,
    errorMessage: t.error_message
  }]));
  res.json({ languages: byLanguage });
});

/* ------------------------------------------------------------------
 * 3) CONTENT  (any logged-in listener) — the actual line-by-line JSON
 *    for one language, resolved from wherever it lives on Drime. Small
 *    and immutable per (mediaItemId, language) once generated — a
 *    re-generate needs the admin to explicitly re-run it, at which point
 *    the app's next online fetch just gets the fresh copy — so this is
 *    safe for the app to cache indefinitely for offline use.
 * ------------------------------------------------------------------ */
router.get('/:mediaItemId/:language/content', requireAuth, async (req, res) => {
  const { data: t } = await supabase.from('transcripts')
    .select('*').eq('media_item_id', req.params.mediaItemId).eq('language', req.params.language).single();
  if (!t || t.status !== 'done' || !t.storage_hash) {
    return res.status(404).json({ error: 'Transcript not available for this language yet' });
  }
  const { data: account } = await supabase.from('storage_accounts').select('*').eq('id', t.storage_account_id).single();
  if (!account) return res.status(404).json({ error: 'Storage account not found' });

  try {
    const creds = loadStorageCreds(account);
    const file = await drime.getFileBuffer({ accessToken: creds.accessToken, hash: t.storage_hash });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.status(200).send(file.buffer);
  } catch (e) {
    res.status(503).json({ error: 'Failed to resolve transcript from Drime: ' + (e.response?.data?.message || e.message) });
  }
});

module.exports = router;