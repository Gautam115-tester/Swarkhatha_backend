const axios = require('axios');
const FormData = require('form-data');
const http = require('http');
const https = require('https');

/**
 * Minimal Groq API client — powers the audio-story transcription /
 * karaoke-lyrics pipeline (see routes/transcripts.js).
 *
 * Groq's Whisper endpoint is only ever used for ONE pass per episode: the
 * audio goes in, and a transcript comes out in whatever language was
 * actually spoken, with LINE-level (segment) timestamps. Every OTHER
 * target language is produced afterwards by feeding those same lines to a
 * Groq-hosted LLM and asking it to translate (or, for Hinglish,
 * transliterate) line-by-line, one input line to one output line. That's
 * what keeps every language's lines lined up against the same timestamps
 * without re-running speech recognition per language.
 *
 * Like storage_accounts/drime.js, Groq keys are pooled across multiple
 * admin-added accounts (see groq_accounts + lib/groqAccountCache.js) simply
 * because Groq's free tier has real per-key rate limits.
 */

const BASE = process.env.GROQ_API_BASE || 'https://api.groq.com/openai/v1';
const WHISPER_MODEL = process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3';
const TEXT_MODEL = process.env.GROQ_TEXT_MODEL || 'llama-3.3-70b-versatile';

// Groq's audio/transcriptions endpoint hard-caps the free tier at 25MB per
// request. A full-length audio-story episode (as opposed to a song) can
// easily cross that at a normal narration bitrate, and when it does, Groq
// has been observed to fail with an opaque 500 "Internal Server Error"
// rather than a clean 413 -- which is indistinguishable, from the caller's
// side, from a real transient outage. Checking the size ourselves turns
// that into an immediate, specific error instead of a confusing one after
// a slow upload.
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

// How many lines go into one translation/transliteration call. Keeps each
// prompt (and the JSON Groq has to hand back) small enough to stay fast and
// reliable — a 300-line episode becomes ~8 calls of ~40 lines each rather
// than one giant call that's more likely to get truncated or malformed.
const SEGMENTS_PER_BATCH = 40;

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

  // Extension-derived content-type wins over whatever the caller passed in
  // -- see the EXT_MIME comment above. Only falls back to the caller's
  // `mime` (or a generic default) when the extension is unrecognized.
  const resolvedMime = mimeForFileName(fileName) || mime || 'audio/mpeg';

  function buildForm() {
    const form = new FormData();
    form.append('file', buffer, { filename: fileName || 'audio.mp3', contentType: resolvedMime });
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

const LANGUAGE_NAMES = { hi: 'Hindi', en: 'English', mr: 'Marathi', bn: 'Bengali' };

function buildPrompt({ texts, targetLanguage }) {
  if (targetLanguage === 'hi-en') {
    return [
      'You will be given a numbered JSON list of lines from a spoken audio-story transcript.',
      'Rewrite EACH line phonetically in Latin/Roman script — the sound of the spoken words spelled out with English letters (Hinglish-style, e.g. Hindi "\u0915\u0939\u093e\u0928\u0940 \u0936\u0941\u0930\u0942 \u0939\u094b\u0924\u0940 \u0939\u0948" -> "kahani shuru hoti hai").',
      'This is a phonetic transliteration, NOT a translation into English meaning, and NOT the original script.',
      'Keep the same number of lines, in the same order — one rewritten line per input line.',
      'Respond ONLY with a JSON object of the exact shape {"lines": ["...", "...", ...]} — no other text, no markdown.',
      '',
      'Input lines:',
      JSON.stringify(texts)
    ].join('\n');
  }
  const targetName = LANGUAGE_NAMES[targetLanguage] || targetLanguage;
  return [
    'You will be given a numbered JSON list of lines from a spoken audio-story transcript.',
    `Translate EACH line into ${targetName}, preserving the storytelling tone and meaning as naturally as possible.`,
    'Keep the same number of lines, in the same order — one translated line per input line.',
    'Respond ONLY with a JSON object of the exact shape {"lines": ["...", "...", ...]} — no other text, no markdown.',
    '',
    'Input lines:',
    JSON.stringify(texts)
  ].join('\n');
}

// Translates (or, for 'hi-en', transliterates) a full list of segments into
// targetLanguage, keeping every segment's original start/end untouched —
// only .text changes. Batches so one long episode doesn't become one giant,
// truncation-prone LLM call. Throws (aborting the whole language) if any
// batch comes back with the wrong line count — a silent mismatch here is
// worse than a visible failure, since it would quietly break timestamp sync
// for every line after the mismatch.
async function translateSegments({ apiKey, segments, targetLanguage }) {
  const out = [];
  for (let i = 0; i < segments.length; i += SEGMENTS_PER_BATCH) {
    const batch = segments.slice(i, i + SEGMENTS_PER_BATCH);
    const texts = batch.map((s) => s.text);

    const resp = await keepAliveClient.post(`${BASE}/chat/completions`, {
      model: TEXT_MODEL,
      messages: [{ role: 'user', content: buildPrompt({ texts, targetLanguage }) }],
      response_format: { type: 'json_object' },
      temperature: 0.2
    }, { headers: authHeaders(apiKey) });

    const raw = resp.data.choices?.[0]?.message?.content || '{}';
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Groq returned non-JSON for a ${targetLanguage} batch: ${e.message}`);
    }
    const lines = Array.isArray(parsed.lines) ? parsed.lines : null;
    if (!lines || lines.length !== batch.length) {
      throw new Error(`Groq returned ${lines?.length ?? 0} lines for a ${targetLanguage} batch of ${batch.length} — aborting to avoid breaking timestamp sync`);
    }

    batch.forEach((s, idx) => out.push({ start: s.start, end: s.end, text: String(lines[idx] || '').trim() }));
  }
  return out;
}

module.exports = { validateKey, transcribe, translateSegments, mimeForFileName };