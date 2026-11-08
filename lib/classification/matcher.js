'use strict';

/**
 * Decides whether an external record IS the recording we hold -- never by title alone.
 *
 * Inputs the score combines: normalised title (version decorations stripped),
 * artist overlap, duration, album, and version agreement. Two outcomes matter:
 *
 *   scope 'recording'   -> same song AND same version/length: this provider's
 *                          recording-specific facts (mood, vocals, version...) apply.
 *   scope 'composition' -> same song but a different version or length (the
 *                          original vs. our Reprise, a 6-minute extended cut...):
 *                          only composition-level facts (broad genre, language) may
 *                          be borrowed, at reduced confidence.
 */
const { parseTitle, similarity, splitArtists } = require('./text');

const same = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

/** Version slugs a candidate title (+ optional disambiguation) carries. */
function versionSet(title, disambiguation) {
  const set = new Set(parseTitle(title).versions.map((v) => v.slug));
  if (disambiguation) for (const v of parseTitle(`x (${disambiguation})`).versions) set.add(v.slug);
  return set;
}

/**
 * track: { base, artists[], durationSec, album, versionSlugs:Set }
 * cand:  { title, artists[], durationSec?, album?, disambiguation? }
 */
function matchRecording(track, cand, cfg) {
  const candBase = parseTitle(cand.title).base;
  const titleSim = similarity(track.base, candBase);
  const candArtists = (cand.artists || []).flatMap((a) => splitArtists(a));
  let artistSim = 0;
  for (const a of track.artists) for (const b of candArtists) artistSim = Math.max(artistSim, similarity(a, b));

  const reject = (reason) => ({ accepted: false, reason, score: 0, titleSim, artistSim });
  if (!track.artists.length) return reject('track has no artist: refusing to match on title alone');
  if (titleSim < 0.82) return reject(`title mismatch (${titleSim.toFixed(2)})`);
  if (artistSim < 0.7) return reject(`artist mismatch (${artistSim.toFixed(2)})`);

  const parts = [[0.45, titleSim], [0.35, artistSim]];
  let durationDelta = null;
  let durationOk = true;
  if (track.durationSec && cand.durationSec) {
    durationDelta = Math.abs(track.durationSec - cand.durationSec);
    const d = durationDelta <= cfg.match.durationToleranceSec ? 1 : durationDelta <= cfg.match.durationRejectSec ? 0.6 : 0;
    durationOk = durationDelta <= cfg.match.durationRejectSec;
    parts.push([0.12, d]);
  }
  if (track.album && cand.album) parts.push([0.08, similarity(track.album, cand.album)]);
  const weight = parts.reduce((s, [w]) => s + w, 0);
  let score = parts.reduce((s, [w, v]) => s + w * v, 0) / weight;
  if (!(track.durationSec && cand.durationSec)) score *= 0.95; // can't confirm it is the same take

  const candVersions = versionSet(cand.title, cand.disambiguation);
  const versionsAgree = same(track.versionSlugs, candVersions);
  const scope = versionsAgree && durationOk ? 'recording' : 'composition';
  const confidence = scope === 'recording' ? score : score * 0.85;

  if (score < cfg.match.minScore) return { ...reject(`score ${score.toFixed(2)} below ${cfg.match.minScore}`), score };
  return {
    accepted: true, scope, score, confidence, titleSim, artistSim, durationDelta,
    versionsAgree, candidateVersions: [...candVersions],
    reason: scope === 'composition' ? (versionsAgree ? 'duration differs: different take/edit' : 'version differs: borrowing composition-level facts only') : 'recording match'
  };
}

/** Best accepted candidate; prefers recording-scope matches over composition-scope. */
function pickBest(track, candidates, cfg) {
  let best = null;
  for (const c of candidates) {
    const m = matchRecording(track, c, cfg);
    if (!m.accepted) continue;
    const rank = (m.scope === 'recording' ? 1 : 0) * 10 + m.confidence;
    if (!best || rank > best.rank) best = { candidate: c, match: m, rank };
  }
  return best;
}

module.exports = { matchRecording, pickBest, versionSet };
