'use strict';

/**
 * Deterministic text analysis used by the classification engine. Nothing here
 * touches the network or the database, which is why the version/language rules
 * can carry high confidence: they're derived from the track's own strings, and
 * from lyrics when the lyrics cache has them, never from the artist's nationality.
 */
const { normalizeText } = require('./taxonomy');

const AUDIO_EXT = /\.(mp3|m4a|flac|wav|aac|ogg|opus|wma|aiff?)$/i;

/** Removes control chars / zero-width junk and collapses whitespace (metadata sanitising). */
function sanitize(value, maxLen = 300) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

/* ---------------------------------------------------------------- artists */

function splitArtists(raw) {
  const s = sanitize(raw);
  if (!s) return [];
  return s.split(/\s*(?:,|&|;|\/|\+|\bfeat\b\.?|\bft\b\.?|\bfeaturing\b|\bwith\b|\bvs\.?\b)\s*/i)
    .map((a) => a.trim()).filter(Boolean);
}

/* ------------------------------------------------------------- similarity */

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 0..1 similarity of two strings (token overlap and edit distance, whichever is higher). */
function similarity(a, b) {
  const x = normalizeText(a);
  const y = normalizeText(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const tx = new Set(x.split(' '));
  const ty = new Set(y.split(' '));
  let inter = 0;
  for (const t of tx) if (ty.has(t)) inter++;
  const jaccard = inter / (tx.size + ty.size - inter);
  const lev = 1 - levenshtein(x, y) / Math.max(x.length, y.length);
  return Math.max(jaccard, lev);
}

/* ------------------------------------------------------- title / version */

// [slug, regex on normalised text, only-valid-inside-decoration?]
const VERSION_RULES = [
  ['slowed-reverb', /\bslowed\s*(\+|and)?\s*(reverb|rvb)\b/, false],
  ['sped-up-version', /\b(sped\s*up|speed\s*up|nightcore)\b/, false],
  ['lo-fi-version', /\blo\s?fi\b/, false],
  ['club-mix', /\bclub (mix|version)\b/, false],
  ['dj-mix', /\bdj (mix|version)\b/, false],
  ['remix', /\b(remix|remixed|rmx)\b/, false],
  ['reprise', /\breprise\b/, false],
  ['unplugged', /\bunplugged\b/, false],
  ['female-version', /\bfemale (version|cover)\b/, false],
  ['male-version', /\bmale (version|cover)\b/, false],
  ['acoustic-version', /\bacoustic( version| mix)?\b/, true],
  ['instrumental-version', /\binstrumental( version| mix)?\b/, true],
  ['extended-version', /\bextended( (version|mix|cut))?\b/, true],
  ['slow-version', /(^slow$)|\bslow (version|mix)\b/, true],
  ['live-version', /\blive( at| from| in| version| performance| session)?\b/, true],
  ['cover-version', /\bcover( version)?\b/, true],
  ['remastered-version', /\bremaster(ed)?( \d{4})?\b/, false],
  ['radio-edit', /\bradio (edit|version|mix)\b/, false]
];

const FILM_RE = /^(?:from|film|movie)\s*[:\-]?\s*["'\u201c\u2018]?\s*(.+?)\s*["'\u201d\u2019]?$/i;
const SOUNDTRACK_RE = /\b(original motion picture soundtrack|original soundtrack|ost|motion picture)\b/i;

/**
 * Splits a raw title into the song's own name and its "decorations":
 *   "Shayad (From \"Love Aaj Kal\") - Reprise"  ->  base "Shayad", decorations ["From \"Love Aaj Kal\"", "Reprise"]
 * Version markers are only trusted where uploaders actually put them: inside
 * brackets, after " - ", or as a trailing keyword. "Live Your Life" is not a live version.
 */
function parseTitle(rawTitle, { album } = {}) {
  const raw = sanitize(rawTitle).replace(AUDIO_EXT, '').replace(/_/g, ' ');
  const decorations = [];

  let rest = raw.replace(/[\(\[\{]([^\)\]\}]*)[\)\]\}]/g, (_, inner) => { decorations.push(inner.trim()); return ' \u0000 '; });
  const dash = rest.search(/\s[-\u2013\u2014|]\s/);
  let base;
  if (dash >= 0) {
    rest.slice(dash).split(/\s[-\u2013\u2014|]\s/).map((s) => s.trim()).filter(Boolean).forEach((s) => decorations.push(s.replace(/\u0000/g, '').trim()));
    base = rest.slice(0, dash);
  } else {
    base = rest;
  }
  base = base.replace(/\u0000/g, ' ').replace(/\s+/g, ' ').trim();

  const versions = new Map(); // slug -> { p, via }
  const addVersion = (slug, p, via) => { if (!versions.has(slug) || versions.get(slug).p < p) versions.set(slug, { p, via }); };

  let film = null;
  for (const d of decorations) {
    const n = normalizeText(d);
    if (!n) continue;
    const fm = d.match(FILM_RE);
    if (fm) { film = sanitize(fm[1]); continue; }
    if (SOUNDTRACK_RE.test(d)) { film = film || '(soundtrack)'; continue; }
    for (const [slug, re] of VERSION_RULES) if (re.test(n)) addVersion(slug, 0.97, 'decoration');
  }

  // Bare trailing keyword: "Shayad Reprise", "Kesariya Lofi" (only unambiguous words).
  const bare = [
    ['reprise', /\s+reprise$/i], ['unplugged', /\s+unplugged$/i], ['remix', /\s+remix$/i],
    ['lo-fi-version', /\s+lo-?\s?fi$/i], ['slowed-reverb', /\s+slowed\s*(\+|and|&)?\s*reverb$/i],
    ['sped-up-version', /\s+sped[\s-]?up$/i], ['female-version', /\s+female version$/i], ['male-version', /\s+male version$/i],
    ['acoustic-version', /\s+acoustic version$/i], ['instrumental-version', /\s+instrumental version$/i],
    ['radio-edit', /\s+radio edit$/i], ['club-mix', /\s+club mix$/i], ['extended-version', /\s+extended version$/i]
  ];
  for (const [slug, re] of bare) {
    if (re.test(base) && base.replace(re, '').trim()) { addVersion(slug, 0.93, 'suffix'); base = base.replace(re, '').trim(); }
  }

  // The album name often carries it too ("Kesariya (Lofi)"): weaker, it may describe the whole release.
  if (album) {
    const an = normalizeText(album);
    for (const [slug, re] of VERSION_RULES) {
      if (!versions.has(slug) && re.test(an) && /[\(\[\-]/.test(album)) addVersion(slug, 0.8, 'album');
    }
  }

  return {
    raw, base, decorations, film,
    versions: [...versions.entries()].map(([slug, v]) => ({ slug, ...v }))
  };
}

/** Normalised key of the song itself (not the recording): shared by every version of it. */
function compositionKey(base) {
  return normalizeText(base).replace(/\s+/g, ' ');
}

/* ----------------------------------------------------------- script/lang */

const SCRIPTS = [
  ['devanagari', /\p{Script=Devanagari}/u],
  ['gurmukhi', /\p{Script=Gurmukhi}/u],
  ['tamil', /\p{Script=Tamil}/u],
  ['telugu', /\p{Script=Telugu}/u],
  ['malayalam', /\p{Script=Malayalam}/u],
  ['bengali', /\p{Script=Bengali}/u],
  ['gujarati', /\p{Script=Gujarati}/u],
  ['kannada', /\p{Script=Kannada}/u],
  ['arabic', /\p{Script=Arabic}/u],
  ['latin', /\p{Script=Latin}/u]
];

function scriptCounts(text) {
  const counts = {};
  let letters = 0;
  for (const ch of String(text || '')) {
    if (!/\p{L}/u.test(ch)) continue;
    letters++;
    for (const [name, re] of SCRIPTS) if (re.test(ch)) { counts[name] = (counts[name] || 0) + 1; break; }
  }
  return { counts, letters };
}

const HI_WORDS = new Set(['है', 'हैं', 'में', 'को', 'का', 'की', 'के', 'नहीं', 'मैं', 'हम', 'तुम', 'से', 'पर', 'कि', 'और', 'ना', 'ये', 'वो', 'था', 'थी', 'तेरे', 'मेरे', 'तेरा', 'मेरा', 'दिल', 'सा', 'भी', 'तो', 'हो', 'रहा', 'रही']);
const MR_WORDS = new Set(['आहे', 'मी', 'तुला', 'मला', 'माझ्या', 'माझे', 'माझी', 'तुझ्या', 'तुझे', 'तुझी', 'नाही', 'काय', 'आणि', 'होतं', 'होती', 'आहेस', 'नाहीस', 'आम्ही', 'तुम्ही', 'च्या', 'ची', 'चा', 'चे', 'मनात', 'सगळं']);
const SA_WORDS = new Set(['नमः', 'ॐ', 'स्वाहा', 'अस्ति', 'त्वं', 'मम', 'तव', 'श्री', 'जय', 'ते', 'सर्व', 'भवतु', 'सुखिनः', 'शान्तिः', 'ह्रीं']);
const EN_WORDS = new Set(['the', 'and', 'you', 'i', 'me', 'my', 'to', 'in', 'of', 'it', 'is', 'that', 'we', 'your', 'on', 'for', 'be', 'with', 'all', 'this', 'are', 'like', 'just', 'so', 'but', 'when', 'what', 'know', 'baby']);
const ROMAN_HI_WORDS = new Set(['hai', 'hain', 'tu', 'tum', 'mein', 'main', 'nahi', 'nahin', 'na', 'ke', 'ki', 'ka', 'ko', 'se', 'mujhe', 'tujhe', 'tere', 'mera', 'meri', 'tera', 'teri', 'dil', 'hum', 'yeh', 'woh', 'kya', 'aur', 'bhi', 'toh', 'jaise', 'kabhi', 'sab', 'tumhe', 'pyaar', 'zindagi', 'raat', 'jo', 'ho', 'tha', 'thi', 'rahe', 'raha']);

const tokens = (text) => String(text || '').toLowerCase().split(/[^\p{L}\p{M}]+/u).filter(Boolean);

/**
 * Language candidates from text alone.
 * Returns [{ slug, p, why }] -- p is a probability-like strength to be combined with
 * other evidence, not a final confidence. [] means "can't tell from this text".
 * `kind` is 'lyrics' (long, reliable) or 'title' (short, weak).
 */
function languageFromText(text, kind = 'lyrics') {
  const { counts, letters } = scriptCounts(text);
  if (letters < 6) return [];
  const long = kind === 'lyrics' && letters >= 60;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const [script, n] = top;
  const share = n / letters;
  const out = [];

  const single = { gurmukhi: 'punjabi', tamil: 'tamil', telugu: 'telugu', malayalam: 'malayalam', bengali: 'bengali', gujarati: 'gujarati', kannada: 'kannada' };
  if (share >= 0.5 && single[script]) {
    out.push({ slug: single[script], p: long ? 0.95 : 0.88, why: `${script} script (${kind})` });
    return out;
  }
  if (share >= 0.5 && script === 'arabic') {
    // Arabic script is also used for Arabic, Persian and Punjabi (Shahmukhi): weak on its own.
    out.push({ slug: 'urdu', p: long ? 0.7 : 0.55, why: `Arabic script (${kind})` });
    return out;
  }
  if (share >= 0.5 && script === 'devanagari') {
    const ws = tokens(text);
    const hi = ws.filter((w) => HI_WORDS.has(w)).length;
    const mr = ws.filter((w) => MR_WORDS.has(w)).length;
    const sa = ws.filter((w) => SA_WORDS.has(w)).length;
    if (sa >= 2 && sa >= hi && sa >= mr) out.push({ slug: 'sanskrit', p: Math.min(0.85, 0.6 + 0.06 * sa), why: `Sanskrit function words x${sa}` });
    else if (mr >= 3 && mr >= 2 * hi) out.push({ slug: 'marathi', p: Math.min(0.93, 0.68 + 0.05 * mr), why: `Marathi function words x${mr}` });
    else if (hi >= 3 && hi >= 2 * mr) out.push({ slug: 'hindi', p: Math.min(0.93, 0.68 + 0.05 * hi), why: `Hindi function words x${hi}` });
    else {
      // Devanagari narrows it to Hindi/Marathi/Sanskrit/Nepali but not which one.
      out.push({ slug: 'hindi', p: 0.5, why: `Devanagari script, no disambiguating words (${kind})` });
      out.push({ slug: 'marathi', p: 0.35, why: `Devanagari script, no disambiguating words (${kind})` });
    }
    return out;
  }
  if (script === 'latin' && share >= 0.8 && kind === 'lyrics') {
    const ws = tokens(text);
    if (ws.length >= 40) {
      const en = ws.filter((w) => EN_WORDS.has(w)).length / ws.length;
      const hi = ws.filter((w) => ROMAN_HI_WORDS.has(w)).length / ws.length;
      if (hi >= 0.12 && hi > en) { out.push({ slug: 'hindi', p: 0.78, why: 'romanised Hindi/Urdu function words' }); out.push({ slug: 'urdu', p: 0.35, why: 'romanised Hindi/Urdu is ambiguous' }); }
      else if (en >= 0.25 && en > 2 * hi) out.push({ slug: 'english', p: 0.9, why: 'English function words in lyrics' });
    }
  }
  return out;
}

module.exports = {
  sanitize, splitArtists, similarity, levenshtein, parseTitle, compositionKey,
  scriptCounts, languageFromText, VERSION_RULES, AUDIO_EXT
};
