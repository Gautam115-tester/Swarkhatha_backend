'use strict';

const { isConfigured } = require('../config');
const { createMusicBrainz } = require('./musicbrainz');
const { createSpotify } = require('./spotify');
const { createLastfm } = require('./lastfm');
const { createLlm } = require('./llm');
const { createAudio } = require('./audio');

/** Fresh provider instances (each owns its own rate limiter / token state). */
function buildProviders() {
  return [createMusicBrainz(), createSpotify(), createLastfm(), createAudio(), createLlm()]
    .map((p) => Object.assign(p, { isConfigured: (cfg) => isConfigured(cfg, p.name) }));
}

module.exports = { buildProviders };
