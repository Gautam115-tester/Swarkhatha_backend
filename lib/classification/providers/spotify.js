'use strict';

/**
 * Spotify Web API, client-credentials flow (no user data involved).
 *
 * Deliberately limited to what the API still offers to Development Mode apps
 * (Spotify's Feb 2026 changes): track search (max 10 results per request),
 * single-artist lookup, track/album names, durations and ids. It does NOT use
 * Audio Features / Audio Analysis / Recommendations, and it does not rely on
 * artist `genres` being present: Spotify marks that field deprecated, so when it
 * is absent this provider simply contributes only the match + ids.
 * Artist genres describe the ARTIST, not this track, so they are weak evidence.
 */
const { createLimiter, fromHttpError, ProviderError, scaled, dedupe } = require('./base');
const { pickBest } = require('../matcher');
const { lookupSynonym, normalizeText } = require('../taxonomy');

const NAME = 'spotify';

function createSpotify({ limiter } = {}) {
  let lim = limiter;
  let token = null; // { value, exp }

  async function getToken(ctx) {
    const cfg = ctx.config.providers.spotify;
    if (token && token.exp > Date.now() + 60000) return token.value;
    try {
      const body = new URLSearchParams({ grant_type: 'client_credentials' }).toString();
      const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
      const r = await ctx.http.post(cfg.tokenUrl, body, {
        headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: ctx.config.providers.timeoutMs
      });
      token = { value: r.data.access_token, exp: Date.now() + (Number(r.data.expires_in) || 3600) * 1000 };
      return token.value;
    } catch (e) { throw fromHttpError(NAME, e); }
  }

  async function get(ctx, path, params, retry = true) {
    const cfg = ctx.config.providers.spotify;
    lim ||= createLimiter(cfg.minIntervalMs);
    const bearer = await getToken(ctx);
    try {
      return await lim.schedule(async () => (await ctx.http.get(`${cfg.baseUrl}${path}`, {
        params, headers: { Authorization: `Bearer ${bearer}` }, timeout: ctx.config.providers.timeoutMs
      })).data);
    } catch (e) {
      if (e?.response?.status === 401 && retry) { token = null; return get(ctx, path, params, false); }
      const err = fromHttpError(NAME, e);
      if (err.kind === 'rate_limited') lim.delay(err.retryAfterMs || 30000);
      throw err;
    }
  }

  return {
    name: NAME,
    group: NAME,
    async lookup(track, ctx) {
      const cfg = ctx.config.providers.spotify;
      const artist = track.artists[0];
      const { payload: cands } = await ctx.cache.getOrFetch(NAME, `search|${normalizeText(track.base)}|${normalizeText(artist)}`, async () => {
        const data = await get(ctx, '/search', { q: `track:${track.base} artist:${artist}`, type: 'track', limit: 10, market: cfg.market });
        const items = (data?.tracks?.items || []).map((t) => ({
          id: t.id, title: t.name,
          artists: (t.artists || []).map((a) => a.name), artistIds: (t.artists || []).map((a) => a.id),
          durationSec: t.duration_ms ? Math.round(t.duration_ms / 1000) : null,
          album: t.album?.name || null, releaseDate: t.album?.release_date || null
        }));
        return items.length ? items : null;
      });
      const best = pickBest(track, cands || [], ctx.config);
      if (!best) return { observations: [], meta: {}, source: null, note: cands?.length ? 'no candidate passed matching' : 'no results' };

      const { candidate, match } = best;
      const mf = match.confidence;
      const obs = [];

      // Artist-level genres (when Spotify still returns them): composition-level, weak.
      let genres = [];
      const firstArtistId = candidate.artistIds[0];
      if (firstArtistId) {
        const { payload: a } = await ctx.cache.getOrFetch(NAME, `artist|${firstArtistId}`, async () => {
          const d = await get(ctx, `/artists/${firstArtistId}`, {});
          return d ? { id: d.id, name: d.name, genres: Array.isArray(d.genres) ? d.genres : [] } : null;
        });
        genres = a?.genres || [];
      }
      for (const g of genres) for (const key of lookupSynonym('genre', g)) obs.push({ key, group: NAME, p: scaled(0.65, 1, mf), scope: 'composition', note: `Spotify artist genre "${g}"` });

      if (match.scope === 'recording') {
        if (!match.candidateVersions.length) obs.push({ key: 'version:original', group: NAME, p: scaled(0.6, 1, mf), scope: 'recording', note: 'matched Spotify track carries no version marker' });
        for (const slug of match.candidateVersions) obs.push({ key: `version:${slug}`, group: NAME, p: scaled(0.85, 1, mf), scope: 'recording', note: `Spotify track title marks it as ${slug}` });
      }

      return {
        observations: dedupe(obs),
        meta: { spotify_track_id: candidate.id },
        source: { externalId: candidate.id, matchConfidence: mf, scope: match.scope, evidence: { matched: { title: candidate.title, artists: candidate.artists, album: candidate.album, durationSec: candidate.durationSec, releaseDate: candidate.releaseDate }, match: { score: Number(match.score.toFixed(3)), reason: match.reason }, artistGenres: genres.slice(0, 8) } }
      };
    }
  };
}

module.exports = { createSpotify, NAME };
