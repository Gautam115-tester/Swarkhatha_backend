const axios = require('axios');
const FormData = require('form-data');
const http = require('http');
const https = require('https');

/**
 * Minimal Groq API client — powers the audio-story transcription /
 * karaoke-lyrics pipeline (see routes/transcripts.js).
 *
 * Groq's Whisper endpoint is used ONCE per episode: the audio goes in, and
 * a transcript comes out in whatever language was actually spoken, with
 * LINE-level (segment) timestamps. Those same lines are then fed to a
 * Groq-hosted LLM and rewritten phonetically in Latin script — "Hinglish"
 * — which is the ONLY transcript this project generates now. (It used to
 * also translate into Hindi/English/Marathi/Bengali; that was removed —
 * see routes/transcripts.js.)
 *
 * Like storage_accounts/drime.js, Groq keys are pooled across multiple
 * admin-added accounts (see groq_accounts + lib/groqAccountCache.js) simply
 * because Groq's free tier has real per-key rate limits.
 */

const BASE = process.env.GROQ_API_BASE || 'https://api.groq.com/openai/v1';
const WHISPER_MODEL = process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3';

// `llama-3.3-70b-versatile` is on Groq's deprecation list — announced
// 2026-06-17, shutdown 2026-08-16 — after which requests to it will start
// erroring. Groq's own recommended replacement is `openai/gpt-oss-120b`
// (see https://console.groq.com/docs/deprecations), so that's the new
// default. Override via GROQ_TEXT_MODEL if you'd rather use
// `qwen/qwen3.6-27b`, Groq's other listed replacement.
const TEXT_MODEL = process.env.GROQ_TEXT_MODEL || 'openai/gpt-oss-120b';

// Groq's audio/transcriptions endpoint hard-caps the free tier at 25MB per
// request (100MB on the dev tier). A full-length audio-story episode (as
// opposed to a song) can easily cross that at a normal narration bitrate,
// and when it does, Groq has been observed to fail with an opaque 500
// "Internal Server Error" rather than a clean 413 -- which is
// indistinguishable, from the caller's side, from a real transient outage.
// Checking the size ourselves turns that into an immediate, specific error
// instead of a confusing one after a slow upload.
const MAX_AUDIO_BYTES = Number(process.env.GROQ_MAX_AUDIO_BYTES || 25 * 1024 * 1024);

// Groq's /audio/transcriptions endpoint takes the multipart part's
// filename/content-type as its cue for how to demux the upload before it
// ever gets to Whisper. Every call into transcribe() used to hardcode
// `contentType: 'audio/mpeg'` regardless of what the file actually was —
// fine for an actual .mp3, but a lie for the .opus (Ogg/Opus) episodes
// this project also handles, and a mismatched container is exactly the
// kind of thing that gets swallowed as an opaque 500 "Internal Server
// Error" instead of a clean 4xx. Deriving the content-type from the real
// file extension (which routes/transcripts.js already has, via
// storage_path) fixes that at the source instead of guessing at retry time.
const EXT_MIME = {
  mp3: 'audio/mpeg',
  mpga: 'audio/mpeg',
  mpeg: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg', // .opus files are (almost always) Opus audio inside an Ogg container
  webm: 'audio/webm'
};

function mimeForFileName(fileName) {
  const ext = String(fileName || '').split('.').pop().toLowerCase();
  return EXT_MIME[ext] || null;
}

// -----------------------------------------------------------------------
// THE ACTUAL BUG behind every language coming back "Transcription failed:
// Internal Server Error" at once (i.e. failing during the Whisper pass
// itself, before any per-language work even starts):
//
// Groq's docs list the file types /audio/transcriptions actually accepts
// by name: flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm.
// (https://console.groq.com/docs/speech-to-text#audio-file-limitations)
// `opus` is NOT on that list. The EXT_MIME fix above corrects the
// Content-Type header we send for a `.opus` upload (audio/ogg — correct,
// since Opus-in-Ogg IS an Ogg container), but it left the multipart
// filename itself untouched, so Groq was still handed a part named
// "whatever.opus". Whisper-style endpoints (Groq's included) determine
// how to demux the upload from that filename's extension, not just the
// Content-Type header — an extension outside their supported list is
// exactly the kind of input that comes back as an opaque 500 instead of a
// clean 4xx, which matches what's in the screenshots.
//
// The fix: the extension in the filename we send Groq is now always one
// Groq's docs say it supports. If the source file's own extension is
// already on that list, it's kept as-is. Otherwise (an unrecognized
// extension, or a recognized-but-unsupported one like `opus`) we swap in
// the extension that matches the Content-Type we're actually sending, so
// the filename and the bytes always agree on a format Groq documents
// support for.
// -----------------------------------------------------------------------
const GROQ_SUPPORTED_EXT = new Set(['flac', 'mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'ogg', 'wav', 'webm']);

const GROQ_FILENAME_EXT_FOR_MIME = {
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm'
};

// -----------------------------------------------------------------------
// SECOND, MORE GENERAL FIX for the same class of bug: resolveGroqUpload()
// above only works if `fileName` (item.storage_path) already carries the
// TRUE extension of the file's actual bytes. That's true for a normal
// .mp3/.m4a upload, but it silently breaks for anything mislabeled,
// extension-less, or renamed somewhere upstream (the app's recorder,
// a manual re-upload, whatever) — that file would get a guessed
// Content-Type from the filename alone, which can just as easily produce
// the exact same opaque Groq 500 the .opus case did, for a totally
// different reason.
//
// Sniffing the container from the file's own magic bytes sidesteps that
// dependency entirely — it doesn't matter what the filename claims, only
// what the bytes actually are. This is checked FIRST; the filename-based
// logic above only runs as a fallback when sniffing is inconclusive
// (buffer too short / genuinely unrecognized header).
// -----------------------------------------------------------------------
function sniffAudioFormat(buffer) {
  if (!buffer || buffer.length < 12) return null;
  const b = buffer;
  // OGG container ("OggS") -- covers both real .ogg and Opus-in-Ogg.
  if (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return { ext: 'ogg', mime: 'audio/ogg' };
  // FLAC ("fLaC")
  if (b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43) return { ext: 'flac', mime: 'audio/flac' };
  // WAV ("RIFF"...."WAVE")
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45) {
    return { ext: 'wav', mime: 'audio/wav' };
  }
  // MP4/M4A family -- 'ftyp' box at byte offset 4
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return { ext: 'm4a', mime: 'audio/mp4' };
  // WEBM/Matroska -- EBML header
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { ext: 'webm', mime: 'audio/webm' };
  // MP3 with an ID3v2 tag
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return { ext: 'mp3', mime: 'audio/mpeg' };
  // Bare MP3 frame sync (no ID3 tag) -- 11 straight set bits
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return { ext: 'mp3', mime: 'audio/mpeg' };
  return null;
}

function resolveGroqUpload(fileName, callerMime, buffer) {
  const name = fileName || 'audio';
  const stem = String(name).includes('.') ? String(name).slice(0, String(name).lastIndexOf('.')) : String(name);

  const sniffed = sniffAudioFormat(buffer);
  if (sniffed) {
    return { mime: sniffed.mime, groqFileName: `${stem}.${sniffed.ext}` };
  }

  // Sniff inconclusive -- fall back to the filename/Content-Type guess.
  const ext = String(name).split('.').pop().toLowerCase();
  const mime = mimeForFileName(name) || callerMime || 'audio/mpeg';
  const groqExt = GROQ_SUPPORTED_EXT.has(ext) ? ext : (GROQ_FILENAME_EXT_FOR_MIME[mime] || 'mp3');
  return { mime, groqFileName: `${stem}.${groqExt}` };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// True for errors worth retrying: Groq-side 5xx responses and
// network-level hiccups. NOT true for 4xx (bad file, bad key, etc.) --
// those will just fail the same way again.
function isTransient(e) {
  const status = e.response?.status;
  if (status) return status >= 500;
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED'].includes(e.code);
}

// How many times to try the SAME key/file combination before giving up on
// it (routes/transcripts.js layers account rotation on top of this, so a
// persistent failure on one key still gets a shot with a different one).
const MAX_ATTEMPTS = Number(process.env.GROQ_TRANSCRIBE_MAX_ATTEMPTS || 3);

// How many lines go into one Hinglish transliteration call. Keeps each
// prompt (and the JSON Groq has to hand back) small enough to stay fast and
// reliable — a 300-line episode becomes ~15 calls of ~20 lines each rather
// than one giant call that's more likely to get truncated or malformed.
//
// Was 40 -- lowered because TEXT_MODEL (openai/gpt-oss-120b) is a reasoning
// model: part of its output budget goes to hidden "reasoning" tokens before
// it ever writes the visible JSON answer (see GPT_OSS_REASONING_EFFORT
// below), so a 40-line batch's expected output was large enough to run
// into that budget and come back truncated -- which Groq's JSON mode
// surfaces as "Failed to generate JSON. Please adjust your prompt. See
// 'failed_generation' for more details," a 400, not a rate limit.
const SEGMENTS_PER_BATCH = Number(process.env.GROQ_SEGMENTS_PER_BATCH || 20);

// openai/gpt-oss-20b and openai/gpt-oss-120b are reasoning models and
// default to 'medium' reasoning effort, which spends part of the response
// budget on hidden reasoning before the actual answer -- for a mechanical
// transliteration task that reasoning doesn't help accuracy, it just eats
// into the budget available for the visible JSON output. 'low' leaves more
// room for the actual answer and reduces the odds of the JSON getting cut
// off. Only applied for gpt-oss models specifically (via TEXT_MODEL) since
// other models either don't support this field or don't need it.
const GPT_OSS_REASONING_EFFORT = process.env.GROQ_TEXT_REASONING_EFFORT || 'low';
const IS_GPT_OSS_TEXT_MODEL = /gpt-oss/i.test(TEXT_MODEL);

// Explicit ceiling on the Hinglish call's output so a batch can't silently
// run into whatever Groq's own implicit default is. Generous relative to
// a 20-line batch of transliterated dialogue, with headroom left for
// reasoning tokens on top.
const HINGLISH_MAX_COMPLETION_TOKENS = Number(process.env.GROQ_HINGLISH_MAX_COMPLETION_TOKENS || 4096);

const keepAliveClient = axios.create({
  httpAgent: new http.Agent({ keepAlive: true, maxSockets: 20 }),
  httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 20 })
});

function authHeaders(apiKey) {
  return { Authorization: `Bearer ${apiKey}` };
}

// Confirms a key actually works, the same moment a Drime token is checked
// via drime.getLoggedUser() — so a typo'd/expired/revoked key is caught the
// instant an admin adds it, not on the first real transcription job.
async function validateKey({ apiKey }) {
  const resp = await keepAliveClient.get(`${BASE}/models`, { headers: authHeaders(apiKey) });
  const models = resp.data.data || [];
  return { modelCount: models.length };
}

// One audio file in, one ORIGINAL-language transcript out, with per-line
// (segment) start/end timestamps. verbose_json + timestamp_granularities:
// ['segment'] is what makes Whisper return line-level timing instead of
// just a flat text blob.
async function transcribe({ apiKey, buffer, fileName, mime }) {
  if (buffer.length > MAX_AUDIO_BYTES) {
    const mb = (n) => (n / (1024 * 1024)).toFixed(1);
    throw new Error(
      `Audio file is ${mb(buffer.length)}MB, over Groq's ${mb(MAX_AUDIO_BYTES)}MB per-request limit for whisper-large-v3. ` +
      `This episode needs to be split into smaller chunks before transcription, or re-encoded at a lower bitrate.`
    );
  }

  // Both the Content-Type header AND the multipart filename extension are
  // now derived together so they always describe the same, Groq-supported
  // format -- see the GROQ_SUPPORTED_EXT comment above for why the
  // filename alone (independent of Content-Type) matters here. The buffer
  // itself is passed in too, so this prefers sniffing the real bytes over
  // trusting the filename -- see sniffAudioFormat() above.
  const { mime: resolvedMime, groqFileName } = resolveGroqUpload(fileName, mime, buffer);

  function buildForm() {
    const form = new FormData();
    form.append('file', buffer, { filename: groqFileName, contentType: resolvedMime });
    form.append('model', WHISPER_MODEL);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
    return form;
  }

  let resp;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const form = buildForm(); // fresh multipart body every attempt -- a FormData can't be re-read after one post
      resp = await keepAliveClient.post(`${BASE}/audio/transcriptions`, form, {
        headers: { ...authHeaders(apiKey), ...form.getHeaders() },
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      });
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      // A 4xx (bad key, bad file, unsupported format) will just fail the
      // same way again -- raise it immediately instead of burning retries.
      if (!isTransient(e)) throw e;
      if (attempt < MAX_ATTEMPTS) await sleep(2000 * attempt); // 2s, 4s, ... backoff
    }
  }
  if (lastErr) throw lastErr;

  const segments = (resp.data.segments || [])
    .map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text || '').trim() }))
    .filter((s) => s.text.length > 0);

  return { language: resp.data.language || null, segments };
}

function buildHinglishPrompt(texts) {
  return [
    'You will be given a numbered JSON list of lines from a spoken audio-story transcript.',
    'Rewrite EACH line phonetically in Latin/Roman script — the sound of the spoken words spelled out with English letters (Hinglish-style, e.g. Hindi "कहानी शुरू होती है" -> "kahani shuru hoti hai").',
    'This is a phonetic transliteration, NOT a translation into English meaning, and NOT the original script.',
    'Keep the same number of lines, in the same order — one rewritten line per input line.',
    'Respond ONLY with a JSON object of the exact shape {"lines": ["...", "...", ...]} — no other text, no markdown.',
    '',
    'Input lines:',
    JSON.stringify(texts)
  ].join('\n');
}

// Transliterates a full list of segments into Hinglish (romanized, spoken
// phonetically in Latin script — NOT an English translation), keeping every
// segment's original start/end untouched — only .text changes. Batches so
// one long episode doesn't become one giant, truncation-prone LLM call.
// Throws (aborting the whole run) if any batch comes back with the wrong
// line count — a silent mismatch here is worse than a visible failure,
// since it would quietly break timestamp sync for every line after the
// mismatch.
// Groq's specific "JSON mode couldn't produce valid JSON" failure -- an
// HTTP 400 with error code json_validate_failed, distinct from a rate
// limit (429) or a genuine bad-request (missing/invalid param). This is
// what a truncated gpt-oss response looks like from the caller's side, so
// it's the signal to retry smaller rather than to rotate accounts or fail
// outright.
function isJsonGenerationFailure(e) {
  const status = e.response?.status;
  const code = e.response?.data?.error?.code;
  const message = e.response?.data?.error?.message || '';
  return status === 400 && (code === 'json_validate_failed' || /failed to generate json/i.test(message));
}

// One Hinglish batch, in from Groq, parsed and length-checked. Split out
// of transliterateToHinglish() so it can be retried on a smaller slice, or
// against a different account, without duplicating the request-building/
// parsing logic.
async function callHinglishBatch({ apiKey, batch }) {
  const texts = batch.map((s) => s.text);

  const body = {
    model: TEXT_MODEL,
    messages: [{ role: 'user', content: buildHinglishPrompt(texts) }],
    response_format: { type: 'json_object' },
    temperature: 0.2,
    max_completion_tokens: HINGLISH_MAX_COMPLETION_TOKENS
  };
  if (IS_GPT_OSS_TEXT_MODEL) body.reasoning_effort = GPT_OSS_REASONING_EFFORT;

  const resp = await keepAliveClient.post(`${BASE}/chat/completions`, body, { headers: authHeaders(apiKey) });

  const raw = resp.data.choices?.[0]?.message?.content || '{}';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Groq returned non-JSON for a Hinglish batch: ${e.message}`);
  }
  const lines = Array.isArray(parsed.lines) ? parsed.lines : null;
  if (!lines || lines.length !== batch.length) {
    throw new Error(`Groq returned ${lines?.length ?? 0} lines for a Hinglish batch of ${batch.length} — aborting to avoid breaking timestamp sync`);
  }
  return lines;
}

// Retries a batch across TWO independent axes:
//  - a 429 (this account's text-model quota, separate from Whisper's ASPH)
//    -> ask getApiKey() for another account from the pool and try again,
//    same spirit as the Whisper-step rotation in routes/transcripts.js.
//    Previously the Hinglish step never rotated at all -- it was stuck on
//    whichever single account happened to succeed on the audio step, so a
//    pool of 6 didn't help this step no matter how many accounts you'd
//    added.
//  - Groq's JSON-generation failure (truncated output) -> split the batch
//    in half and retry each half, since a smaller expected response is
//    what actually fixes that, not a different account.
// accountAttempts bounds the 429 axis so a pool that's entirely exhausted
// still fails instead of looping forever.
async function transliterateBatchWithRetry({ getApiKey, onRateLimited, batch, accountAttempts }) {
  let lastErr;
  for (let attempt = 0; attempt < accountAttempts; attempt++) {
    const { account, apiKey } = await getApiKey();
    try {
      return await callHinglishBatch({ apiKey, batch });
    } catch (e) {
      lastErr = e;
      if (e.response?.status === 429) {
        if (onRateLimited) await onRateLimited(account, e);
        continue; // next loop iteration asks getApiKey() for a different account
      }
      if (isJsonGenerationFailure(e) && batch.length > 1) {
        const mid = Math.ceil(batch.length / 2);
        const firstHalf = await transliterateBatchWithRetry({ getApiKey, onRateLimited, batch: batch.slice(0, mid), accountAttempts });
        const secondHalf = await transliterateBatchWithRetry({ getApiKey, onRateLimited, batch: batch.slice(mid), accountAttempts });
        return [...firstHalf, ...secondHalf];
      }
      throw e; // not a 429, not a fixable JSON truncation -- a real error
    }
  }
  throw lastErr;
}

// Transliterates a full list of segments into Hinglish (romanized, spoken
// phonetically in Latin script — NOT an English translation), keeping every
// segment's original start/end untouched — only .text changes. Batches so
// one long episode doesn't become one giant, truncation-prone LLM call.
// Throws (aborting the whole run) if any batch comes back with the wrong
// line count — a silent mismatch here is worse than a visible failure,
// since it would quietly break timestamp sync for every line after the
// mismatch.
//
// getApiKey() -- async () => {account, apiKey} -- and onRateLimited(account,
// error) are supplied by the caller (routes/transcripts.js) so this stays
// decoupled from how the account pool itself is stored/picked; it just
// asks for "the next account to try" and reports back when one's rate
// limited.
async function transliterateToHinglish({ getApiKey, onRateLimited, segments, accountAttempts = 3 }) {
  const out = [];
  for (let i = 0; i < segments.length; i += SEGMENTS_PER_BATCH) {
    const batch = segments.slice(i, i + SEGMENTS_PER_BATCH);
    const lines = await transliterateBatchWithRetry({ getApiKey, onRateLimited, batch, accountAttempts });
    batch.forEach((s, idx) => out.push({ start: s.start, end: s.end, text: String(lines[idx] || '').trim() }));
  }
  return out;
}

// Pulls the most useful error detail out of a failed axios call to Groq.
// routes/transcripts.js previously did `e.response?.data?.error?.message
// || e.message` inline, which is exactly what produced the bare
// "Transcription failed: Internal Server Error" in the admin app -- true,
// but not enough to tell an unsupported-format 500 apart from a genuinely
// transient one after the fact. This adds the HTTP status and (when the
// body isn't the expected {error:{message}} shape -- e.g. an HTML error
// page from an infra-level 500) a trimmed raw body, so the stored
// error_message is actually diagnostic next time something fails.
function extractErrorMessage(e) {
  const status = e.response?.status;
  const data = e.response?.data;
  let detail = data?.error?.message;
  // Groq's json_validate_failed error carries the model's actual raw
  // (invalid/truncated) output in error.failed_generation -- surfacing a
  // slice of it here means a future truncation shows exactly what the
  // model produced instead of just "adjust your prompt," which is enough
  // to tell a truncation apart from the model genuinely going off-script.
  const failedGeneration = data?.error?.failed_generation;
  if (!detail) {
    if (typeof data === 'string' && data.trim()) detail = data.trim().slice(0, 300);
    else if (data && typeof data === 'object') {
      try { detail = JSON.stringify(data).slice(0, 300); } catch (_) { /* ignore */ }
    }
  }
  detail = detail || e.message;
  if (failedGeneration) detail += ` | failed_generation: ${String(failedGeneration).slice(0, 200)}`;
  return status ? `HTTP ${status}: ${detail}` : detail;
}

// Groq's 429 body for ASPH-style (audio-seconds-per-hour) rate limits
// spells out how long the caller actually needs to wait, e.g. "Please try
// again in 6m43s." or "Please try again in 7.66s." That number reflects
// how long until enough of the org's trailing-hour usage ages out of the
// window, which is almost always much longer than a flat request-rate
// cooldown -- routes/transcripts.js uses this to set a per-account
// cooldown that actually matches Groq's own quota window, instead of
// re-trying an account before it's really cleared. Returns null when the
// message doesn't contain a recognizable wait time (e.g. a non-rate-limit
// error), so callers can fall back to a flat default.
function parseRetryAfterMs(message) {
  if (!message) return null;
  const match = String(message).match(/try again in (?:(\d+)m)?([\d.]+)s/i);
  if (!match) return null;
  const minutes = match[1] ? Number(match[1]) : 0;
  const seconds = Number(match[2]) || 0;
  const totalMs = Math.round((minutes * 60 + seconds) * 1000);
  return totalMs > 0 ? totalMs : null;
}

module.exports = { validateKey, transcribe, transliterateToHinglish, mimeForFileName, extractErrorMessage, parseRetryAfterMs };