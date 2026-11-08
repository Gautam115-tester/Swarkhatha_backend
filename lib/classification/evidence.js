'use strict';

/**
 * Evidence aggregation: turns observations into per-label confidences.
 *
 * An observation is { key: 'genre:bollywood', group, p, scope, note }:
 *   group  independence group (the underlying source of the claim); p is already
 *          reliability x strength x recording-match, computed by the producer.
 *
 * Model (all deterministic, nothing fabricated):
 *   1. Evidence for a child genre also supports its ancestors (Bollywood -> Indian Film Music).
 *   2. Within ONE group only the strongest observation counts. Two APIs that echo
 *      the same underlying data must share a group, or they would be double-counted;
 *      different Last.fm tags, say, never add up on their own.
 *   3. Across groups, probabilities combine as a noisy-OR:  P = 1 - prod(1 - p_g).
 *      Independent sources agreeing raise confidence; one weak source never reaches "approved".
 *   4. Contradiction: conf = P * (1 - penalty * P_best_competitor), where competitors are
 *      labels that exclude each other (one lead vocal type, one language, Original vs any
 *      other version).
 *   5. The status comes from configurable thresholds; the 0.85-0.95 band is approved only
 *      with >= 2 independent groups or one deterministic group (title parsing / manual).
 */
const { competitorsOf, ancestorsOf } = require('./taxonomy');

// Groups that read the track's own strings or lyrics (so there is no outside source to corroborate them);
// they still need p >= 0.9 to be approved on their own.
const DETERMINISTIC_GROUPS = new Set(['title_parse', 'text_script', 'manual']);

const round3 = (n) => Math.round(n * 1000) / 1000;

function noisyOr(ps) { return 1 - ps.reduce((acc, p) => acc * (1 - p), 1); }

/**
 * Returns Map<key, { key, confidence, rawP, groups:[{group,p,notes}], scopes, competitorP }>.
 * `allowedScopes` per key is checked by the caller (engine) before observations get here.
 */
function aggregate(observations, cfg) {
  // 1. propagate genre evidence up the hierarchy
  const all = [];
  for (const o of observations) {
    all.push(o);
    for (const a of ancestorsOf(o.key)) all.push({ ...o, key: a, derivedFrom: o.key });
  }

  // 2. strongest observation per (key, group)
  const perKey = new Map(); // key -> Map(group -> {p, notes[], scope})
  for (const o of all) {
    if (!(o.p > 0)) continue;
    if (!perKey.has(o.key)) perKey.set(o.key, new Map());
    const g = perKey.get(o.key);
    const cur = g.get(o.group);
    if (!cur || o.p > cur.p) g.set(o.group, { p: o.p, notes: [o.derivedFrom ? `${o.note} (via ${o.derivedFrom})` : o.note], scope: o.scope || 'recording' });
    else if (cur && o.p === cur.p && o.note && !cur.notes.includes(o.note)) cur.notes.push(o.note);
  }

  // 3. noisy-OR across groups
  const raw = new Map();
  for (const [key, groups] of perKey) raw.set(key, noisyOr([...groups.values()].map((g) => g.p)));

  // 4. contradiction penalty
  const out = new Map();
  for (const [key, groups] of perKey) {
    const rawP = raw.get(key);
    const competitorP = Math.max(0, ...competitorsOf(key).map((c) => raw.get(c) || 0));
    const confidence = rawP * (1 - cfg.competitorPenalty * competitorP);
    out.set(key, {
      key,
      confidence: round3(confidence),
      rawP: round3(rawP),
      competitorP: round3(competitorP),
      groups: [...groups.entries()].map(([group, g]) => ({ group, p: round3(g.p), notes: g.notes, scope: g.scope })).sort((a, b) => b.p - a.p)
    });
  }
  return out;
}

/** 'approved' | 'provisional' | 'needs_review' | null (below every threshold: not stored). */
function decideStatus(entry, cfg) {
  const t = cfg.thresholds;
  const c = entry.confidence;
  if (c >= t.approve) return 'approved';
  if (c >= t.supported) {
    const independent = entry.groups.length >= 2;
    const deterministic = entry.groups.some((g) => DETERMINISTIC_GROUPS.has(g.group) && g.p >= 0.9);
    return independent || deterministic ? 'approved' : 'provisional';
  }
  if (c >= t.provisional) return 'provisional';
  if (c >= t.review) return 'needs_review';
  return null;
}

/** The stored `source`: what a reader of the label should understand produced it. */
function sourceOf(entry) {
  const names = entry.groups.map((g) => g.group);
  if (names.length === 1) return { title_parse: 'title_parse', audio: 'audio_analysis', existing_label: 'existing_label', text_script: 'lyrics_script', llm: 'llm_inference' }[names[0]] || names[0];
  if (names.includes('audio') && entry.groups[0].group === 'audio') return 'audio_analysis';
  return 'metadata_consensus';
}

module.exports = { aggregate, decideStatus, sourceOf, noisyOr, DETERMINISTIC_GROUPS };
