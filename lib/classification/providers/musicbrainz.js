'use strict';

/**
 * MusicBrainz (https://musicbrainz.org/doc/MusicBrainz_API).
 *
 * Calls per uncached track: 1 recording search, 1 recording lookup, then at most
 * 1 work lookup (language) and up to 2 artist lookups (vocal gender). Everything is
 * cached; calls are spaced >= 1.1 s apart (their documented limit is 1 request/s)
 * and a descriptive User-Agent with a contact is mandatory -- without
 * MUSICBRAINZ_CONTACT this provider is not considered configured and never calls out.
 *
 * Facts used: curated genres + community tags, the linked work's language, the
 * recording's disambiguation text (version), credited artists' gender/type.
 * What it does NOT provide: mood/energy/tempo; those need audio analysis.
 */
const { ProviderError, createLimiter, fromHttpError, scaled, dedupe } = require('./base');
const { pickBest, versionSet } = require('../matcher');
const { lookupSynonym, normalizeText } = require('../taxonomy');
const { similarity } = require('../text');

const NAME = 'musicbrainz';
const lucene = (s) => String(s).replace(/([+\-&|!(){}\[\]^"~*?:\\/])/g, '\\$1');

function userAgent(cfg) {
  return `SwarKatha/1.0 ( ${cfg.providers.musicbrainz.contact} )`;
}

function createMusicBrainz({ limiter } = {}) {
  let lim = limiter;

  async function get(ctx, path, params) {
    const cfg = ctx.config.providers.musicbrainz;
    lim ||= createLimiter(cfg.minIntervalMs);
    try {
      return await lim.schedule(async () => {
        const r = await ctx.http.get(`${cfg.baseUrl}${path}`, {
          params: { fmt: 'json', ...params },
          headers: { 'User-Agent': userAgent(ctx.config), Accept: 'application/json' },
          timeout: ctx.config.providers.timeoutMs
        });
        return r.data;
      });
    } catch (e) {
      const err = fromHttpError(NAME, e);
      if (err.kind === 'rate_limited') lim.delay(err.retryAfterMs || 5000);
      throw err;
    }
  }

  async function searchRecordings(ctx, track) {
    const artist = track.artists[0];
    const key = `search|${normalizeText(track.base)}|${normalizeText(artist)}`;
    const { payload } = await ctx.cache.getOrFetch(NAME, key, async () => {
      const q = `recording:"${lucene(track.base)}" AND artist:"${lucene(artist)}"`;
      const data = await get(ctx, '/recording', { query: q, limit: 5 });
      const recs = (data?.recordings || []).map((r) => ({
        id: r.id,
        title: r.title,
        artists: (r['artist-credit'] || []).map((c) => c.name || c.artist?.name).filter(Boolean),
        artistIds: (r['artist-credit'] || []).map((c) => c.artist?.id).filter(Boolean),
        durationSec: r.length ? Math.round(r.length / 1000) : null,
        album: r.releases?.[0]?.title || null,
        disambiguation: r.disambiguation || ''
      }));
      return recs.length ? recs : null;
    });
    return payload || [];
  }

  async function lookupRecording(ctx, id) {
    const { payload } = await ctx.cache.getOrFetch(NAME, `rec|${id}`, async () => {
      const d = await get(ctx, `/recording/${id}`, { inc: 'genres+tags+artist-credits+work-rels+isrcs' });
      if (!d) return null;
      const works = (d.relations || []).filter((r) => r.work).map((r) => r.work);
      return {
        id: d.id,
        genres: (d.genres || []).map((g) => ({ name: g.name, count: g.count || 0 })),
        tags: (d.tags || []).map((t) => ({ name: t.name, count: t.count || 0 })),
        isrc: d.isrcs?.[0] || null,
        work: works[0] ? { id: works[0].id, title: works[0].title, languages: works[0].languages || (works[0].language ? [works[0].language] : []) } : null,
        artistIds: (d['artist-credit'] || []).map((c) => c.artist?.id).filter(Boolean)
      };
    });
    return payload;
  }

  async function lookupWorkLanguages(ctx, workId) {
    const { payload } = await ctx.cache.getOrFetch(NAME, `work|${workId}`, async () => {
      const d = await get(ctx, `/work/${workId}`, {});
      return d ? { languages: d.languages || (d.language ? [d.language] : []) } : null;
    });
    return payload?.languages || [];
  }

  async function lookupArtist(ctx, id) {
    const { payload } = await ctx.cache.getOrFetch(NAME, `artist|${id}`, async () => {
      const d = await get(ctx, `/artist/${id}`, {});
      return d ? { id: d.id, name: d.name, type: d.type || null, gender: d.gender || null } : null;
    });
    return payload;
  }

  return {
    name: NAME,
    group: NAME,
    async lookup(track, ctx) {
      const candidates = await searchRecordings(ctx, track);
      const best = pickBest(track, candidates, ctx.config);
      if (!best) return { observations: [], meta: {}, source: null, note: candidates.length ? 'no candidate passed matching' : 'no results' };

      const { candidate, match } = best;
      const rec = await lookupRecording(ctx, candidate.id);
      if (!rec) return { observations: [], meta: {}, source: null, note: 'recording lookup returned nothing' };

      const mf = match.confidence;
      const recordingScope = match.scope === 'recording';
      const obs = [];
      const push = (key, p, note, scope) => obs.push({ key, group: NAME, p, scope: scope || match.scope, note });

      // Curated genres are stronger than free community tags.
      for (const g of rec.genres) {
        const strength = Math.min(1, 0.75 + 0.05 * g.count);
        for (const key of lookupSynonym('genre', g.name)) push(key, scaled(0.85, strength, mf), `MB genre "${g.name}" (${g.count})`);
      }
      for (const t of rec.tags) {
        const strength = Math.min(1, 0.6 + 0.08 * t.count);
        for (const key of lookupSynonym('genre', t.name)) push(key, scaled(0.6, strength, mf), `MB tag "${t.name}" (${t.count})`);
        for (const key of lookupSynonym('language', t.name)) push(key, scaled(0.55, strength, mf), `MB tag "${t.name}"`);
        if (recordingScope) {
          for (const dim of ['mood', 'characteristic', 'context']) {
            for (const key of lookupSynonym(dim, t.name)) push(key, scaled(0.5, strength, mf), `MB tag "${t.name}"`, 'recording');
          }
          if (normalizeText(t.name) === 'instrumental') {
            push('vocal:instrumental', scaled(0.6, strength, mf), 'MB tag "instrumental"', 'recording');
            push('language:instrumental', scaled(0.55, strength, mf), 'MB tag "instrumental"', 'recording');
          }
        }
      }

      // Language of the linked work: editor-entered, composition-level.
      let languages = rec.work?.languages || [];
      if (rec.work?.id && !languages.length) languages = await lookupWorkLanguages(ctx, rec.work.id);
      for (const code of languages) for (const key of lookupSynonym('language', code)) push(key, scaled(0.9, 1, mf), `MB work language "${code}"`, 'composition');

      // Version: the recording's own disambiguation, and "no version marker" as weak support for Original.
      if (recordingScope) {
        const vs = versionSet(candidate.title, candidate.disambiguation);
        for (const slug of vs) push(`version:${slug}`, scaled(0.85, 1, mf), `MB title/disambiguation marks it as ${slug}`, 'recording');
        if (vs.size === 0) push('version:original', scaled(0.6, 1, mf), 'matched MB recording carries no version marker', 'recording');
      }

      // Vocal gender from credited artists' own metadata (a hint, never proof: credited artist != vocalist).
      if (recordingScope && ctx.config.providers.musicbrainz.lookupArtists !== false && rec.artistIds.length && rec.artistIds.length <= 3) {
        const artists = [];
        for (const id of rec.artistIds) { const a = await lookupArtist(ctx, id); if (a) artists.push(a); }
        const people = artists.filter((a) => a.type === 'Person' && (a.gender === 'Male' || a.gender === 'Female'));
        if (artists.length && people.length === artists.length) {
          const genders = new Set(people.map((a) => a.gender));
          if (people.length === 1) push(genders.has('Male') ? 'vocal:male-vocal' : 'vocal:female-vocal', scaled(0.72, 1, mf), `MB credits one ${people[0].gender.toLowerCase()} artist`, 'recording');
          else if (genders.size === 2) push('vocal:male-female-duet', scaled(0.6, 1, mf), 'MB credits a male and a female artist', 'recording');
        } else if (artists.length === 1 && artists[0].type === 'Group') {
          push('vocal:group-vocals', scaled(0.45, 1, mf), 'MB credits a group', 'recording');
        }
      }

      return {
        observations: dedupe(obs),
        meta: { musicbrainz_recording_id: candidate.id, musicbrainz_work_id: rec.work?.id || null, isrc: rec.isrc || null },
        source: { externalId: candidate.id, matchConfidence: mf, scope: match.scope, evidence: { matched: { title: candidate.title, artists: candidate.artists, durationSec: candidate.durationSec, disambiguation: candidate.disambiguation }, match: { score: Number(match.score.toFixed(3)), reason: match.reason }, genres: rec.genres.slice(0, 8), tags: rec.tags.slice(0, 12), workLanguages: languages } }
      };
    }
  };
}

module.exports = { createMusicBrainz, NAME };
