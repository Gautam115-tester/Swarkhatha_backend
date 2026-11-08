'use strict';

/**
 * Last.fm tags (track.getTopTags / artist.getTopTags).
 *
 * Community tags are noisy and Last.fm cannot confirm the exact recording (no
 * duration or recording id), so this provider is deliberately weak:
 *  - strength scales with the tag's normalised count and tags under
 *    LASTFM_MIN_TAG_COUNT are ignored;
 *  - a track whose title carries a version marker only gets composition-level
 *    (genre / language) evidence, because Last.fm usually folds versions together;
 *  - artist tags only ever support genre/language, at lower weight.
 * It never decides anything alone: reliability tops out at 0.6.
 */
const { fromHttpError, createLimiter, scaled, dedupe, ProviderError } = require('./base');
const { lookupSynonym, normalizeText } = require('../taxonomy');

const NAME = 'lastfm';

function createLastfm({ limiter } = {}) {
  let lim = limiter;

  async function call(ctx, method, params) {
    const cfg = ctx.config.providers.lastfm;
    lim ||= createLimiter(cfg.minIntervalMs);
    try {
      return await lim.schedule(async () => (await ctx.http.get(cfg.baseUrl, {
        params: { method, api_key: cfg.apiKey, format: 'json', autocorrect: 1, ...params },
        timeout: ctx.config.providers.timeoutMs
      })).data);
    } catch (e) {
      const err = fromHttpError(NAME, e);
      if (err.kind === 'rate_limited') lim.delay(err.retryAfterMs || 10000);
      throw err;
    }
  }

  // Last.fm answers HTTP 200 with {error: N, message} for API-level problems.
  function assertOk(data) {
    if (data?.error) {
      if (data.error === 6) return false;                      // "not found": a real, cacheable answer
      if (data.error === 29) throw new ProviderError(NAME, 'rate_limited', 'rate limit exceeded', { retryAfterMs: 60000 });
      if (data.error === 10 || data.error === 26) throw new ProviderError(NAME, 'auth', 'API key rejected', { retryable: false });
      throw new ProviderError(NAME, 'unavailable', `API error ${data.error}`);
    }
    return true;
  }

  const tagsOf = (data, min) => {
    const raw = data?.toptags?.tag;
    const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return arr.map((t) => ({ name: t.name, count: Number(t.count) || 0 })).filter((t) => t.count >= min);
  };

  return {
    name: NAME,
    group: NAME,
    async lookup(track, ctx) {
      const cfg = ctx.config.providers.lastfm;
      const artist = track.artists[0];
      const hasVersion = track.versionSlugs.size > 0;

      const { payload: trackTags } = await ctx.cache.getOrFetch(NAME, `track|${normalizeText(track.base)}|${normalizeText(artist)}`, async () => {
        const d = await call(ctx, 'track.getTopTags', { artist, track: track.base });
        return assertOk(d) ? tagsOf(d, cfg.minTagCount) : null;
      });
      const { payload: artistTags } = await ctx.cache.getOrFetch(NAME, `artist|${normalizeText(artist)}`, async () => {
        const d = await call(ctx, 'artist.getTopTags', { artist });
        return assertOk(d) ? tagsOf(d, cfg.minTagCount) : null;
      });

      const mf = hasVersion ? 0.6 : 0.75; // name-level match only
      const obs = [];
      const strength = (t) => 0.5 + 0.5 * Math.min(1, t.count / 100);
      for (const t of trackTags || []) {
        for (const key of lookupSynonym('genre', t.name)) obs.push({ key, group: NAME, p: scaled(0.6, strength(t), mf), scope: 'composition', note: `Last.fm track tag "${t.name}" (${t.count})` });
        for (const key of lookupSynonym('language', t.name)) obs.push({ key, group: NAME, p: scaled(0.55, strength(t), mf), scope: 'composition', note: `Last.fm track tag "${t.name}" (${t.count})` });
        if (!hasVersion) {
          for (const dim of ['mood', 'characteristic', 'context']) {
            for (const key of lookupSynonym(dim, t.name)) obs.push({ key, group: NAME, p: scaled(0.5, strength(t), mf), scope: 'recording', note: `Last.fm track tag "${t.name}" (${t.count})` });
          }
          if (normalizeText(t.name) === 'instrumental') {
            obs.push({ key: 'vocal:instrumental', group: NAME, p: scaled(0.55, strength(t), mf), scope: 'recording', note: 'Last.fm tag "instrumental"' });
            obs.push({ key: 'language:instrumental', group: NAME, p: scaled(0.5, strength(t), mf), scope: 'recording', note: 'Last.fm tag "instrumental"' });
          }
        }
      }
      for (const t of artistTags || []) {
        for (const dim of ['genre', 'language']) {
          for (const key of lookupSynonym(dim, t.name)) obs.push({ key, group: NAME, p: scaled(0.4, strength(t), 0.8), scope: 'composition', note: `Last.fm artist tag "${t.name}" (${t.count})` });
        }
      }

      const any = (trackTags?.length || 0) + (artistTags?.length || 0) > 0;
      return {
        observations: dedupe(obs),
        meta: {},
        source: any ? { externalId: null, matchConfidence: mf, scope: hasVersion ? 'composition' : 'recording', evidence: { trackTags: (trackTags || []).slice(0, 12), artistTags: (artistTags || []).slice(0, 12) } } : null
      };
    }
  };
}

module.exports = { createLastfm, NAME };
