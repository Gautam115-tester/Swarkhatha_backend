const express = require('express');
const supabase = require('../lib/supabaseClient');
const { decrypt } = require('../lib/crypto');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const drime = require('../lib/drime');
const groq = require('../lib/groq');
const groqAccounts = require('../lib/groqAccountCache');

const router = express.Router();

// Fixed target set: Hindi, English, Marathi, Bengali, and romanized
// Hindi/"Hinglish" (spoken words phonetically in Latin script, NOT an
// English translation — see groq.js#buildPrompt). Whichever of these the
// episode was actually narrated in gets its lines straight from Whisper;
// the rest are translated/transliterated from that same pass so every
// language stays lined up against one set of timestamps.
const LANGUAGES = ['hi', 'en', 'mr', 'bn', 'hi-en'];
const WHISPER_LANG_TO_CODE = { hindi: 'hi', english: 'en', marathi: 'mr', bengali: 'bn' };

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
 * 1) GENERATE  (admin only) — kicks off transcription + translation for
 *    all 5 languages for one episode. Responds immediately and runs the
 *    actual work in the background (matches the "don't await, let the
 *    response return immediately" pattern already used for the Drime
 *    live-storage monitor); the admin app polls GET /:mediaItemId for
 *    progress. One episode at a time per call — concurrency isn't needed
 *    at this project's scale, and it keeps Groq rate-limit handling simple.
 * ------------------------------------------------------------------ */
router.post('/:mediaItemId/generate', requireAuth, requireAdmin, async (req, res) => {
  const { data: item } = await supabase.from('media_items').select('*').eq('id', req.params.mediaItemId).single();
  if (!item) return res.status(404).json({ error: 'Media item not found' });
  if (item.type !== 'audio_story') return res.status(400).json({ error: 'Transcription is only available for audio_story items' });
  if (!item.storage_hash) return res.status(500).json({ error: 'This episode has no storage_hash on file' });

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
  let groqAccount;
  let original;
  try {
    groqAccount = await groqAccounts.pick();
    original = await groq.transcribe({
      apiKey: loadGroqKey(groqAccount),
      buffer: audioBuffer,
      fileName: item.storage_path,
      mime: 'audio/mpeg'
    });
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    if (e.response?.status === 429 && groqAccount) groqAccounts.markRateLimited(groqAccount.id);
    if (groqAccount) groqAccounts.markError(groqAccount.id, msg);
    for (const lang of LANGUAGES) await setStatus(item.id, lang, { status: 'failed', error_message: `Transcription failed: ${msg}` });
    return;
  }

  if (original.segments.length === 0) {
    for (const lang of LANGUAGES) await setStatus(item.id, lang, { status: 'failed', error_message: 'Whisper returned no speech segments — is this file silent or corrupted?' });
    return;
  }

  const sourceCode = WHISPER_LANG_TO_CODE[(original.language || '').toLowerCase()] || null;

  // 3) One language at a time, so a single failure (e.g. one bad LLM batch)
  // never blocks the others from completing.
  for (const lang of LANGUAGES) {
    try {
      const segments = lang === sourceCode
        ? original.segments // straight from Whisper, no LLM pass needed
        : await groq.translateSegments({ apiKey: loadGroqKey(groqAccount), segments: original.segments, targetLanguage: lang });

      const stored = await uploadTranscriptJson({ mediaItem: item, language: lang, segments });
      await setStatus(item.id, lang, {
        status: 'done',
        source_language: original.language || null,
        is_source: lang === sourceCode,
        segment_count: segments.length,
        storage_account_id: stored.storageAccountId,
        storage_file_id: stored.storageFileId,
        storage_hash: stored.storageHash,
        storage_path: stored.storagePath,
        generated_by_account_id: groqAccount.id,
        error_message: null
      });
    } catch (e) {
      const msg = e.response?.data?.error?.message || e.message;
      if (e.response?.status === 429) groqAccounts.markRateLimited(groqAccount.id);
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
