'use strict';

/**
 * Observations derived from the track's own data (no network): version markers in
 * the title/album, the film hint, the pre-existing legacy label, and the language of
 * the title/lyrics script. Each carries its own group so it counts once.
 */
const { parseTitle, languageFromText } = require('./text');
const { legacyNameToKey, lookupSynonym } = require('./taxonomy');

const ORIGINAL_ABSENCE_P = 0.72;

/** version slug -> extra facts a version marker implies about vocals/language */
const IMPLIES = {
  'female-version': [['vocal:female-vocal', 0.92]],
  'male-version': [['vocal:male-vocal', 0.92]],
  'instrumental-version': [['vocal:instrumental', 0.95], ['language:instrumental', 0.93]]
};

function titleObservations(parsed) {
  const obs = [];
  for (const v of parsed.versions) {
    const via = { decoration: 'in brackets / after a dash', suffix: 'as a trailing keyword', album: 'in the album name' }[v.via];
    obs.push({ key: `version:${v.slug}`, group: 'title_parse', p: v.p, scope: 'recording', note: `"${v.slug}" marker ${via}` });
    for (const [key, p] of IMPLIES[v.slug] || []) {
      obs.push({ key, group: 'title_parse', p: p * (v.p >= 0.9 ? 1 : 0.85), scope: 'recording', note: `implied by the ${v.slug} marker` });
    }
  }
  const strongMarker = parsed.versions.some((v) => v.via !== 'album');
  if (!parsed.versions.length) {
    obs.push({ key: 'version:original', group: 'title_parse', p: ORIGINAL_ABSENCE_P, scope: 'recording', note: 'no version marker in title or album' });
  } else if (!strongMarker) {
    // only the album hints at a version: not enough to call the track "original"
  }
  if (parsed.film) {
    obs.push({ key: 'genre:film-music', group: 'title_parse', p: 0.6, scope: 'composition', note: parsed.film === '(soundtrack)' ? 'title marks it as a soundtrack' : `title says it is from the film "${parsed.film}"` });
  }
  return obs;
}

function legacyObservations(legacyName) {
  const key = legacyNameToKey(legacyName);
  if (!key) return [];
  const obs = [{ key, group: 'existing_label', p: 0.8, scope: 'composition', note: `existing app label "${legacyName}" (origin unknown: admin or earlier auto-categorizer)` }];
  if (key === 'genre:instrumental') {
    obs.push({ key: 'vocal:instrumental', group: 'existing_label', p: 0.7, scope: 'recording', note: 'legacy label "Instrumental"' });
    obs.push({ key: 'language:instrumental', group: 'existing_label', p: 0.6, scope: 'recording', note: 'legacy label "Instrumental"' });
  }
  return obs;
}

function languageObservations({ title, album, artist, lyrics }) {
  const obs = [];
  const add = (cands) => { for (const c of cands) for (const key of lookupSynonym('language', c.slug)) obs.push({ key, group: 'text_script', p: c.p, scope: 'composition', note: c.why }); };
  if (lyrics && String(lyrics).trim().length >= 40) add(languageFromText(lyrics, 'lyrics'));
  // The title/album/artist strings are only a fallback: a Devanagari title says little about WHICH language.
  if (!obs.length) add(languageFromText(`${title || ''} ${album || ''}`, 'title').map((c) => ({ ...c, p: c.p * 0.9 })));
  return obs;
}

module.exports = { titleObservations, legacyObservations, languageObservations, parseTitle, ORIGINAL_ABSENCE_P };
