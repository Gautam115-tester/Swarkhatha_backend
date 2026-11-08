'use strict';

/**
 * Controlled vocabulary for the music classification engine.
 *
 * ONE source of truth: this file. supabase/seed_music_labels.sql is generated
 * from it by `node scripts/generate-music-labels-seed.js` (a test fails if the
 * two drift apart) and `ensureTaxonomy()` in store.js upserts it at runtime.
 *
 * A label's identity is `${dimension}:${slug}` -- slugs may repeat across
 * dimensions (e.g. "instrumental" is a genre, a vocal type and a language).
 *
 * `synonyms` map free text (Last.fm / MusicBrainz tags, LLM output, title
 * decorations) onto the label. They are matched on normalised text.
 * `legacy` is the name of the matching row in the pre-existing content_labels
 * table (see migration_labels_albums.sql), used to keep media_items.category /
 * content_label_id in step without ever overwriting a value already there.
 */

const DIMENSIONS = ['genre', 'mood', 'characteristic', 'vocal', 'language', 'context', 'version'];

const def = (dimension, slug, name, extra = {}) => ({ dimension, slug, name, synonyms: [], ...extra });

/* ----------------------------------------------------------------- genre */
// Parents are listed before their children (the SQL seed relies on this order).
const GENRES = [
  def('genre', 'indian-music', 'Indian Music', { synonyms: ['indian', 'desi'], description: 'Umbrella for music from the Indian subcontinent' }),
  def('genre', 'film-music', 'Indian Film Music', { parent: 'indian-music', synonyms: ['film music', 'filmi', 'indian film music', 'soundtrack', 'movie songs', 'film songs'] }),
  def('genre', 'hindi-film-music', 'Hindi Film Music', { parent: 'film-music', synonyms: ['hindi film music', 'hindi film', 'hindi cinema', 'hindi movie songs', 'hindi soundtrack'] }),
  def('genre', 'bollywood', 'Bollywood', { parent: 'film-music', legacy: 'Bollywood', synonyms: ['bollywood', 'bollywood music', 'bollywood songs'] }),
  def('genre', 'bollywood-romantic', 'Bollywood Romantic', { parent: 'bollywood', synonyms: ['bollywood romantic', 'bollywood romance'] }),
  def('genre', 'indian-pop', 'Indian Pop', { parent: 'indian-music', synonyms: ['indian pop', 'hindi pop', 'indipop', 'indi pop'] }),
  def('genre', 'punjabi', 'Punjabi', { parent: 'indian-music', synonyms: ['punjabi', 'punjabi pop', 'bhangra', 'punjabi music'] }),
  def('genre', 'sufi', 'Sufi', { parent: 'indian-music', synonyms: ['sufi', 'sufi music', 'sufi rock', 'sufi pop'] }),
  def('genre', 'qawwali', 'Qawwali', { parent: 'sufi', synonyms: ['qawwali', 'qawali'] }),
  def('genre', 'ghazal', 'Ghazal', { parent: 'indian-music', synonyms: ['ghazal', 'ghazals'] }),
  def('genre', 'semi-classical', 'Semi-Classical', { parent: 'indian-music', synonyms: ['semi classical', 'semi-classical', 'thumri', 'light classical'] }),
  def('genre', 'classical', 'Classical', { legacy: 'Classical', synonyms: ['classical', 'classical music', 'indian classical', 'western classical'] }),
  def('genre', 'hindustani-classical', 'Hindustani Classical', { parent: 'classical', synonyms: ['hindustani', 'hindustani classical', 'raga', 'khayal'] }),
  def('genre', 'carnatic-classical', 'Carnatic Classical', { parent: 'classical', synonyms: ['carnatic', 'carnatic classical'] }),
  def('genre', 'folk', 'Folk', { legacy: 'Folk', synonyms: ['folk', 'folk music', 'indian folk', 'lok geet', 'folk song'] }),
  def('genre', 'devotional', 'Devotional', { legacy: 'Devotional', synonyms: ['devotional', 'bhajan', 'bhakti', 'aarti', 'religious', 'spiritual music', 'kirtan', 'mantra'] }),
  def('genre', 'indie', 'Indie', { synonyms: ['indie', 'independent', 'indie pop', 'indie folk', 'indie rock'] }),
  def('genre', 'pop', 'Pop', { synonyms: ['pop', 'pop music', 'dance pop', 'synthpop', 'electropop'] }),
  def('genre', 'rock', 'Rock', { synonyms: ['rock', 'hard rock', 'alternative rock', 'pop rock', 'indie rock', 'soft rock'] }),
  def('genre', 'electronic', 'Electronic', { synonyms: ['electronic', 'electronica', 'house', 'techno', 'synthwave', 'trance'] }),
  def('genre', 'edm', 'EDM', { parent: 'electronic', synonyms: ['edm', 'electronic dance music', 'big room', 'dubstep'] }),
  def('genre', 'hip-hop', 'Hip-Hop', { synonyms: ['hip hop', 'hip-hop', 'hiphop', 'desi hip hop', 'trap'] }),
  def('genre', 'rap', 'Rap', { parent: 'hip-hop', synonyms: ['rap', 'rapper'] }),
  def('genre', 'jazz', 'Jazz', { synonyms: ['jazz', 'smooth jazz', 'jazz fusion'] }),
  def('genre', 'blues', 'Blues', { synonyms: ['blues'] }),
  def('genre', 'rnb', 'R&B', { synonyms: ['r&b', 'rnb', 'r and b', 'rhythm and blues', 'contemporary r&b'] }),
  def('genre', 'soul', 'Soul', { synonyms: ['soul', 'neo soul'] }),
  def('genre', 'country', 'Country', { synonyms: ['country', 'country music'] }),
  def('genre', 'instrumental', 'Instrumental', { legacy: 'Instrumental', synonyms: ['instrumental', 'instrumentals'] }),
  def('genre', 'world-music', 'World Music', { synonyms: ['world music', 'world', 'fusion', 'ethnic']})
];

/* ------------------------------------------------------------------ mood */
const mood = (slug, name, synonyms = []) => def('mood', slug, name, { synonyms: [name.toLowerCase(), ...synonyms] });
const MOODS = [
  mood('romantic', 'Romantic', ['romance', 'love song', 'love songs', 'love']),
  mood('happy', 'Happy', ['feel good', 'feel-good', 'cheerful', 'joyful']),
  mood('sad', 'Sad', ['sad songs', 'sadness', 'sorrow']),
  mood('melancholic', 'Melancholic', ['melancholy', 'wistful', 'bittersweet']),
  mood('nostalgic', 'Nostalgic', ['nostalgia', 'throwback', 'retro']),
  mood('emotional', 'Emotional', ['emotive', 'heartfelt']),
  mood('heartbreak', 'Heartbreak', ['heartbroken', 'breakup', 'break up', 'broken heart', 'dard']),
  mood('peaceful', 'Peaceful', ['serene', 'tranquil']),
  mood('calm', 'Calm', ['chill', 'chillout', 'relaxing', 'mellow', 'soothing']),
  mood('hopeful', 'Hopeful', ['hope', 'optimistic']),
  mood('inspirational', 'Inspirational', ['inspiring', 'motivational', 'motivation']),
  mood('spiritual', 'Spiritual', ['spirituality', 'divine']),
  mood('energetic', 'Energetic', ['energy', 'high energy', 'upbeat', 'peppy']),
  mood('aggressive', 'Aggressive', ['angry', 'fierce']),
  mood('mysterious', 'Mysterious', ['dark', 'eerie']),
  mood('dreamy', 'Dreamy', ['dream pop', 'ethereal', 'atmospheric']),
  mood('uplifting', 'Uplifting', ['positive', 'euphoric']),
  mood('intense', 'Intense', ['powerful', 'epic']),
  mood('playful', 'Playful', ['fun', 'quirky', 'cute']),
  mood('sensual', 'Sensual', ['sexy', 'seductive', 'sultry'])
];

/* -------------------------------------------------------- characteristic */
const ch = (slug, name, synonyms = []) => def('characteristic', slug, name, { synonyms: [name.toLowerCase(), ...synonyms] });
const CHARACTERISTICS = [
  ch('acoustic', 'Acoustic', ['acoustic guitar', 'unplugged']),
  ch('electronic', 'Electronic', ['electronica', 'electro']),
  ch('orchestral', 'Orchestral', ['orchestra', 'symphonic', 'strings']),
  ch('melodic', 'Melodic', ['melody']),
  ch('percussion-heavy', 'Percussion-Heavy', ['percussion', 'drums', 'dhol', 'tabla']),
  ch('guitar-based', 'Guitar-Based', ['guitar']),
  ch('piano-based', 'Piano-Based', ['piano']),
  ch('synth-based', 'Synth-Based', ['synth', 'synthesizer', 'synthpop']),
  ch('bass-heavy', 'Bass-Heavy', ['bass', 'bass boosted', 'bassline']),
  ch('danceable', 'Danceable', ['dance', 'groovy', 'danceable']),
  ch('minimal', 'Minimal', ['minimalist', 'minimalistic']),
  ch('cinematic', 'Cinematic', ['film score', 'score']),
  ch('ambient', 'Ambient', ['ambient music', 'drone']),
  ch('folk-inspired', 'Folk-Inspired', ['folk influenced']),
  ch('disco-inspired', 'Disco-Inspired', ['disco', 'nu disco']),
  ch('classical-inspired', 'Classical-Inspired', ['classical influenced']),
  ch('lo-fi', 'Lo-Fi', ['lofi', 'lo fi', 'lo-fi hip hop']),
  ch('live-recording', 'Live Recording', ['live', 'concert', 'live performance'])
];

/* ----------------------------------------------------------------- vocal */
// Labels sharing `group` are mutually exclusive: evidence for one counts against the others.
const vocal = (slug, name, synonyms = [], group) => def('vocal', slug, name, { synonyms, ...(group ? { group } : {}) });
const VOCALS = [
  vocal('male-vocal', 'Male Vocal', ['male vocalist', 'male vocals', 'male singer', 'male voice'], 'vocal-lead'),
  vocal('female-vocal', 'Female Vocal', ['female vocalist', 'female vocals', 'female singer', 'female voice'], 'vocal-lead'),
  vocal('male-female-duet', 'Male-Female Duet', ['duet', 'duets', 'male female duet'], 'vocal-lead'),
  vocal('group-vocals', 'Group Vocals', ['group vocals', 'vocal group', 'band vocals'], 'vocal-lead'),
  vocal('choir', 'Choir', ['choir', 'chorus', 'choral'], 'vocal-lead'),
  vocal('instrumental', 'Instrumental', ['instrumental', 'no vocals'], 'vocal-lead'),
  vocal('spoken-word', 'Spoken Word', ['spoken word', 'recitation', 'poetry']),
  vocal('rap-vocal', 'Rap Vocal', ['rap vocals', 'rapping', 'rap']),
  vocal('mixed-vocals', 'Mixed Vocals', ['mixed vocals'], 'vocal-lead')
];

/* -------------------------------------------------------------- language */
const lang = (slug, name, synonyms = []) => def('language', slug, name, { synonyms: [name.toLowerCase(), ...synonyms], group: 'language' });
const LANGUAGES = [
  lang('hindi', 'Hindi', ['hin', 'hi', 'hindi songs']),
  lang('english', 'English', ['eng', 'en']),
  lang('punjabi', 'Punjabi', ['pan', 'pa', 'panjabi']),
  lang('marathi', 'Marathi', ['mar', 'mr']),
  lang('tamil', 'Tamil', ['tam', 'ta']),
  lang('telugu', 'Telugu', ['tel', 'te']),
  lang('malayalam', 'Malayalam', ['mal', 'ml']),
  lang('bengali', 'Bengali', ['ben', 'bn', 'bangla']),
  lang('gujarati', 'Gujarati', ['guj', 'gu']),
  lang('kannada', 'Kannada', ['kan', 'kn']),
  lang('urdu', 'Urdu', ['urd', 'ur']),
  lang('sanskrit', 'Sanskrit', ['san', 'sa']),
  def('language', 'multilingual', 'Multilingual', { synonyms: ['multilingual', 'mul', 'mixed language'], group: 'language' }),
  def('language', 'instrumental', 'Instrumental / No Lyrics', { synonyms: ['instrumental', 'zxx', 'no lyrics', 'no linguistic content'], group: 'language' })
];

/* --------------------------------------------------------------- context */
const cx = (slug, name, synonyms = []) => def('context', slug, name, { synonyms: [name.toLowerCase(), ...synonyms] });
const CONTEXTS = [
  cx('late-night', 'Late Night', ['late night', 'night', 'midnight', 'night drive']),
  cx('road-trip', 'Road Trip', ['road trip', 'roadtrip']),
  cx('driving', 'Driving', ['drive', 'car', 'driving music']),
  cx('workout', 'Workout', ['gym', 'running', 'fitness', 'exercise']),
  cx('party', 'Party', ['party music', 'club', 'party songs']),
  cx('dance', 'Dance', ['dance music', 'dancing']),
  cx('relaxation', 'Relaxation', ['relax', 'relaxing', 'unwind']),
  cx('meditation', 'Meditation', ['meditate', 'yoga', 'mindfulness']),
  cx('study', 'Study', ['studying', 'homework']),
  cx('focus', 'Focus', ['concentration', 'deep focus']),
  cx('love', 'Love', ['love songs', 'romantic evening']),
  cx('heartbreak', 'Heartbreak', ['breakup songs']),
  cx('wedding', 'Wedding', ['shaadi', 'sangeet', 'wedding songs']),
  cx('celebration', 'Celebration', ['festive', 'festival', 'celebrate']),
  cx('rainy-day', 'Rainy Day', ['rain', 'monsoon', 'barish', 'rainy']),
  cx('travel', 'Travel', ['travelling', 'journey']),
  cx('sleep', 'Sleep', ['sleeping', 'lullaby', 'bedtime'])
];

/* --------------------------------------------------------------- version */
const ver = (slug, name, synonyms = []) => def('version', slug, name, { synonyms: [name.toLowerCase(), ...synonyms] });
const VERSIONS = [
  ver('original', 'Original', ['original version', 'original mix', 'studio version']),
  ver('remix', 'Remix', ['remixed']),
  ver('reprise', 'Reprise', ['reprise version']),
  ver('unplugged', 'Unplugged', ['mtv unplugged']),
  ver('acoustic-version', 'Acoustic Version', ['acoustic version', 'acoustic']),
  ver('female-version', 'Female Version', ['female version', 'female cover']),
  ver('male-version', 'Male Version', ['male version']),
  ver('instrumental-version', 'Instrumental Version', ['instrumental version', 'instrumental']),
  ver('extended-version', 'Extended Version', ['extended', 'extended mix', 'extended version']),
  ver('slow-version', 'Slow Version', ['slow version', 'slow']),
  ver('lo-fi-version', 'Lo-Fi Version', ['lofi', 'lo-fi', 'lo fi']),
  ver('club-mix', 'Club Mix', ['club mix', 'club version']),
  ver('dj-mix', 'DJ Mix', ['dj mix', 'dj version']),
  ver('live-version', 'Live Version', ['live', 'live at', 'live version']),
  ver('cover-version', 'Cover Version', ['cover', 'cover version']),
  ver('remastered-version', 'Remastered Version', ['remastered', 'remaster']),
  ver('radio-edit', 'Radio Edit', ['radio edit', 'radio version']),
  ver('sped-up-version', 'Sped-Up Version', ['sped up', 'sped-up', 'speed up', 'nightcore']),
  ver('slowed-reverb', 'Slowed + Reverb', ['slowed reverb', 'slowed and reverb', 'slowed + reverb', 'slowed & reverb', 'slowed'])
];

const ALL_LABELS = [].concat(GENRES, MOODS, CHARACTERISTICS, VOCALS, LANGUAGES, CONTEXTS, VERSIONS);

const keyOf = (dimension, slug) => `${dimension}:${slug}`;
const BY_KEY = new Map(ALL_LABELS.map((l) => [keyOf(l.dimension, l.slug), l]));

if (BY_KEY.size !== ALL_LABELS.length) throw new Error('taxonomy: duplicate dimension:slug');
for (const l of ALL_LABELS) {
  if (l.parent && !BY_KEY.has(keyOf(l.dimension, l.parent))) throw new Error(`taxonomy: ${l.slug} has unknown parent ${l.parent}`);
}

function normalizeText(s) {
  return String(s ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}+]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

// normalised synonym -> [label keys], per dimension
const SYNONYM_INDEX = new Map();
for (const l of ALL_LABELS) {
  for (const s of new Set([l.name, l.slug.replace(/-/g, ' '), ...l.synonyms])) {
    const n = normalizeText(s);
    if (!n) continue;
    const k = `${l.dimension}|${n}`;
    if (!SYNONYM_INDEX.has(k)) SYNONYM_INDEX.set(k, []);
    if (!SYNONYM_INDEX.get(k).includes(keyOf(l.dimension, l.slug))) SYNONYM_INDEX.get(k).push(keyOf(l.dimension, l.slug));
  }
}

const get = (key) => BY_KEY.get(key) || null;

/** Maps a free-text tag onto label keys in one dimension (exact normalised match). */
function lookupSynonym(dimension, text) {
  return SYNONYM_INDEX.get(`${dimension}|${normalizeText(text)}`) || [];
}

/** Keys of all ancestors, nearest first. */
function ancestorsOf(key) {
  const out = [];
  let cur = get(key);
  while (cur && cur.parent) {
    const pk = keyOf(cur.dimension, cur.parent);
    out.push(pk);
    cur = get(pk);
  }
  return out;
}

/**
 * Labels whose evidence counts AGAINST `key`.
 *  - labels in the same exclusive `group` (one lead vocal type, one language)
 *  - "original" conflicts with every other version label (but remix + female-version may coexist)
 */
function competitorsOf(key) {
  const l = get(key);
  if (!l) return [];
  if (l.dimension === 'version') {
    if (l.slug === 'original') return VERSIONS.filter((v) => v.slug !== 'original').map((v) => keyOf('version', v.slug));
    return [keyOf('version', 'original')];
  }
  if (!l.group) return [];
  return ALL_LABELS.filter((o) => o.group === l.group && o.slug !== l.slug && o.dimension === l.dimension).map((o) => keyOf(o.dimension, o.slug));
}

const LEGACY_TO_KEY = new Map(ALL_LABELS.filter((l) => l.legacy).map((l) => [normalizeText(l.legacy), keyOf(l.dimension, l.slug)]));

/** Maps a pre-existing content_labels.name / media_items.category to a genre key (or null). */
function legacyNameToKey(name) {
  const n = normalizeText(name);
  if (!n) return null;
  if (LEGACY_TO_KEY.has(n)) return LEGACY_TO_KEY.get(n);
  const hit = lookupSynonym('genre', name);
  return hit.length === 1 ? hit[0] : null;
}

/** Name to write into the legacy content_labels table for a genre key (or null if none). */
function legacyNameForKey(key) {
  const l = get(key);
  if (!l) return null;
  if (l.legacy) return l.legacy;
  // A child genre (e.g. Bollywood Romantic) maps to the nearest ancestor that has a legacy label.
  for (const a of ancestorsOf(key)) { const al = get(a); if (al?.legacy) return al.legacy; }
  return null;
}

module.exports = {
  DIMENSIONS, ALL_LABELS, GENRES, MOODS, CHARACTERISTICS, VOCALS, LANGUAGES, CONTEXTS, VERSIONS,
  keyOf, get, lookupSynonym, ancestorsOf, competitorsOf, legacyNameToKey, legacyNameForKey, normalizeText
};
