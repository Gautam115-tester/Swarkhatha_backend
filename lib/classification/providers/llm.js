'use strict';

/**
 * LLM knowledge as WEAK evidence (reuses the Groq account pool the project
 * already has -- no new paid dependency). Only title / artist / album / year are
 * sent, never audio, and never the other providers' results: that keeps this
 * source independent of them, so its agreement with MusicBrainz or Last.fm is
 * real corroboration rather than an echo.
 *
 * An LLM's self-reported confidence is not calibrated, so it is only used to
 * scale a hard per-dimension ceiling (genre/language 0.60, vocal/mood 0.50,
 * characteristic 0.35, context 0.30). On its own it can therefore never produce
 * an approved label. If the model does not recognise the specific song it
 * answers {"known_song": false} and contributes nothing.
 */
const { ALL_LABELS, GENRES, keyOf } = require('../taxonomy');
const { normalizeText } = require('../taxonomy');

const NAME = 'llm';
const CAPS = { genre: 0.6, language: 0.6, vocal: 0.5, mood: 0.5, characteristic: 0.35, context: 0.3 };
const VOCAB_DIMS = Object.keys(CAPS);

const VOCAB = Object.fromEntries(VOCAB_DIMS.map((d) => [d, ALL_LABELS.filter((l) => l.dimension === d).map((l) => l.name)]));
// Bump when the prompt changes so answers cached under the old prompt are not reused.
const PROMPT_VERSION = 2;

// "Indian Music > Indian Film Music > Bollywood > Bollywood Romantic" lines, one per genre, so the model sees the hierarchy.
const GENRE_BY_SLUG = new Map(GENRES.map((g) => [g.slug, g]));
const GENRE_TREE = GENRES.map((g) => {
  const chain = [g.name];
  for (let p = g.parent && GENRE_BY_SLUG.get(g.parent); p; p = p.parent && GENRE_BY_SLUG.get(p.parent)) chain.unshift(p.name);
  return chain.join(' > ');
}).filter((line) => line.includes(' > '));

const NAME_TO_KEY = new Map(ALL_LABELS.map((l) => [`${l.dimension}|${l.name.toLowerCase()}`, keyOf(l.dimension, l.slug)]));

function createLlm() {
  return {
    name: NAME,
    group: NAME,
    async lookup(track, ctx) {
      if (typeof ctx.llmClassify !== 'function') return { observations: [], meta: {}, source: null, note: 'no LLM backend wired' };
      const key = `v${ctx.config.version}.p${PROMPT_VERSION}|${normalizeText(track.base)}|${normalizeText(track.artists.join(' '))}|${normalizeText(track.album || '')}`;
      const { payload } = await ctx.cache.getOrFetch(NAME, key, async () => {
        const r = await ctx.llmClassify({ title: track.base, artist: track.artists.join(', '), album: track.album || null, year: track.albumYear || null, vocab: VOCAB, genreTree: GENRE_TREE });
        return r || null;
      });
      if (!payload || !payload.knownSong) return { observations: [], meta: {}, source: null, note: 'LLM did not recognise the song' };

      const hasVersion = track.versionSlugs.size > 0;
      const obs = [];
      for (const dim of VOCAB_DIMS) {
        if (hasVersion && dim !== 'genre' && dim !== 'language') continue; // can't tell which version it was judging
        for (const pick of payload.picks?.[dim] || []) {
          const k = NAME_TO_KEY.get(`${dim}|${String(pick.name).toLowerCase()}`);
          if (!k) continue;
          obs.push({ key: k, group: NAME, p: CAPS[dim] * Math.max(0, Math.min(1, pick.confidence)), scope: dim === 'genre' || dim === 'language' ? 'composition' : 'recording', note: `LLM recalled "${pick.name}" (self-reported ${pick.confidence})` });
        }
      }
      return {
        observations: obs.filter((o) => o.p > 0),
        meta: {},
        source: { externalId: null, matchConfidence: null, scope: 'composition', evidence: { knownSong: true, picks: payload.picks } }
      };
    }
  };
}

module.exports = { createLlm, NAME, VOCAB };
