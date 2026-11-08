'use strict';

/**
 * Optional audio-analysis adapter. This project ships NO audio model: it speaks
 * a small HTTP contract to an analyzer YOU run (e.g. a container wrapping Essentia
 * or a similar maintained model), so the heavy dependency never lands on the
 * Render web instance.
 *
 * Privacy: disabled unless AUDIO_ANALYSIS_ENABLED=true AND AUDIO_ANALYSIS_CONSENT=true
 * AND AUDIO_ANALYZER_URL is set. The analyzer receives a short-lived (default 15 min),
 * single-track, stream-only signed link to this backend -- never storage credentials --
 * and fetches the audio itself. Point it at infrastructure you control.
 *
 * Contract:  POST {AUDIO_ANALYZER_URL}   Authorization: Bearer <AUDIO_ANALYZER_TOKEN> (optional)
 *   request  { "trackId": "...", "url": "https://.../stream/<id>?token=...", "durationSeconds": 241 }
 *   response { "tempo": 96.2, "energy": 0.41, "danceability": 0.38, "acousticness": 0.71,
 *              "instrumentalness": 0.02, "vocalPresence": 0.93, "vocalGender": "male"|"female"|"mixed"|null,
 *              "language": {"code": "hin", "score": 0.9} | null,
 *              "labels": [ {"dimension": "genre"|"mood"|"characteristic"|"context"|"vocal"|"language",
 *                           "name": "Bollywood", "score": 0.93}, ... ] }
 * Every field is optional. Scores are the model's own 0..1 outputs.
 */
const { ProviderError, fromHttpError, scaled, dedupe } = require('./base');
const { lookupSynonym } = require('../taxonomy');

const NAME = 'audio';
const RELIABILITY = 0.85;

function createAudio() {
  return {
    name: NAME,
    group: NAME,
    timeoutMs: undefined,
    async lookup(track, ctx) {
      const cfg = ctx.config.providers.audio;
      if (typeof ctx.audioLink !== 'function') return { observations: [], meta: {}, source: null, note: 'no audio link factory wired' };
      const url = await ctx.audioLink(track.id, cfg.linkTtlSeconds);
      let data;
      try {
        const r = await ctx.http.post(cfg.url, { trackId: track.id, url, durationSeconds: track.durationSec || null }, {
          headers: { 'Content-Type': 'application/json', ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}) },
          timeout: cfg.timeoutMs
        });
        data = r.data;
      } catch (e) { throw fromHttpError(NAME, e); }
      if (!data || typeof data !== 'object') throw new ProviderError(NAME, 'bad_response', 'analyzer returned no JSON object', { retryable: false });

      const obs = [];
      const push = (key, score, note) => { if (score >= 0.5) obs.push({ key, group: NAME, p: scaled(RELIABILITY, Math.min(1, score)), scope: 'recording', note }); };

      for (const l of Array.isArray(data.labels) ? data.labels : []) {
        const score = Number(l.score);
        if (!Number.isFinite(score)) continue;
        for (const key of lookupSynonym(String(l.dimension), String(l.name))) push(key, score, `audio model: ${l.dimension} "${l.name}" ${score.toFixed(2)}`);
      }
      if (data.language?.code && Number(data.language.score) > 0) {
        for (const key of lookupSynonym('language', data.language.code)) push(key, Number(data.language.score), `audio model language ${data.language.code}`);
      }
      // Direct, uncontroversial numeric mappings only.
      if (Number(data.instrumentalness) >= 0.85 || (data.vocalPresence !== undefined && Number(data.vocalPresence) <= 0.08)) {
        const s = Math.max(Number(data.instrumentalness) || 0, 1 - (data.vocalPresence ?? 1));
        push('vocal:instrumental', s, 'audio model: no vocals detected');
        push('language:instrumental', s, 'audio model: no vocals detected');
      }
      if (Number(data.danceability) >= 0.7) push('characteristic:danceable', Number(data.danceability), `audio danceability ${data.danceability}`);
      if (Number(data.acousticness) >= 0.8) push('characteristic:acoustic', Number(data.acousticness), `audio acousticness ${data.acousticness}`);
      if (data.vocalGender === 'male') push('vocal:male-vocal', 0.8, 'audio model vocal gender');
      if (data.vocalGender === 'female') push('vocal:female-vocal', 0.8, 'audio model vocal gender');
      if (data.vocalGender === 'mixed') push('vocal:mixed-vocals', 0.7, 'audio model vocal gender');

      return {
        observations: dedupe(obs),
        meta: {},
        source: { externalId: null, matchConfidence: 1, scope: 'recording', evidence: { tempo: data.tempo ?? null, energy: data.energy ?? null, danceability: data.danceability ?? null, acousticness: data.acousticness ?? null, instrumentalness: data.instrumentalness ?? null, vocalPresence: data.vocalPresence ?? null, vocalGender: data.vocalGender ?? null } }
      };
    }
  };
}

module.exports = { createAudio, NAME };
