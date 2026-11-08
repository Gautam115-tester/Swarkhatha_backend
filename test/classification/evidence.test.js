'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../../lib/classification/evidence');
const { load } = require('../../lib/classification/config');
const cfg = load({});
const o = (key, group, p, extra = {}) => ({ key, group, p, scope: 'recording', note: `${group} says ${key}`, ...extra });
const one = (obs, key) => { const m = E.aggregate(obs, cfg); return { e: m.get(key), status: m.get(key) && E.decideStatus(m.get(key), cfg) }; };

test('independent sources combine (noisy-OR); one weak source cannot approve', () => {
  assert.equal(one([o('mood:sad', 'lastfm', 0.5)], 'mood:sad').status, 'needs_review');
  const two = one([o('mood:sad', 'lastfm', 0.5), o('mood:sad', 'llm', 0.5)], 'mood:sad');
  assert.equal(two.e.confidence, 0.75); assert.equal(two.status, 'provisional');
});

test('the same group never stacks: many Last.fm tags are still one voice', () => {
  const r = one([o('genre:pop', 'lastfm', 0.5), o('genre:pop', 'lastfm', 0.55), o('genre:pop', 'lastfm', 0.45)], 'genre:pop');
  assert.equal(r.e.confidence, 0.55); assert.equal(r.e.groups.length, 1);
});

test('thresholds: >=0.95 approved; 0.85-0.94 needs >=2 groups or a deterministic source; 0.70-0.84 provisional; 0.5-0.69 review; below not stored', () => {
  const st = (c, groups) => E.decideStatus({ confidence: c, groups: groups.map((g) => ({ group: g, p: 0.9 })) }, cfg);
  assert.equal(st(0.96, ['musicbrainz']), 'approved');
  assert.equal(st(0.9, ['musicbrainz']), 'provisional');
  assert.equal(st(0.9, ['musicbrainz', 'lastfm']), 'approved');
  assert.equal(st(0.9, ['title_parse']), 'approved');
  assert.equal(st(0.75, ['musicbrainz', 'lastfm']), 'provisional');
  assert.equal(st(0.55, ['llm']), 'needs_review');
  assert.equal(st(0.3, ['llm']), null);
});

test('thresholds are configurable', () => {
  const strict = load({ CLASSIFY_THRESHOLD_APPROVE: '0.99', CLASSIFY_THRESHOLD_SUPPORTED: '0.97' });
  assert.equal(E.decideStatus({ confidence: 0.96, groups: [{ group: 'a', p: 1 }, { group: 'b', p: 1 }] }, strict), 'provisional');
});

test('contradicting evidence lowers confidence (one language, one lead vocal)', () => {
  const alone = one([o('language:hindi', 'musicbrainz', 0.9)], 'language:hindi').e.confidence;
  const contested = one([o('language:hindi', 'musicbrainz', 0.9), o('language:marathi', 'lastfm', 0.8)], 'language:hindi').e.confidence;
  assert.ok(contested < alone - 0.3, `${contested} vs ${alone}`);
  // labels that are NOT exclusive do not penalise each other
  const m = E.aggregate([o('mood:happy', 'llm', 0.5), o('mood:sad', 'llm', 0.5)], cfg);
  assert.equal(m.get('mood:happy').confidence, 0.5);
});

test('Original is contradicted by any other version marker, but remix + female version coexist', () => {
  const m = E.aggregate([o('version:original', 'title_parse', 0.72), o('version:remix', 'title_parse', 0.97), o('version:female-version', 'title_parse', 0.97)], cfg);
  assert.ok(m.get('version:original').confidence < cfg.thresholds.review, 'Original must fall below the review threshold when a version marker exists');
  assert.equal(m.get('version:remix').confidence, Math.round(0.97 * (1 - 0.6 * 0.72) * 1000) / 1000);
  assert.ok(m.get('version:female-version').confidence > 0.5);
});

test('child-genre evidence supports its ancestors', () => {
  const m = E.aggregate([o('genre:bollywood-romantic', 'musicbrainz', 0.8)], cfg);
  for (const k of ['genre:bollywood', 'genre:film-music', 'genre:indian-music']) assert.equal(m.get(k).confidence, 0.8, k);
});

test('source names', () => {
  const m = E.aggregate([o('genre:pop', 'musicbrainz', 0.9), o('genre:pop', 'lastfm', 0.5), o('mood:sad', 'audio', 0.8), o('language:hindi', 'llm', 0.5)], cfg);
  assert.equal(E.sourceOf(m.get('genre:pop')), 'metadata_consensus');
  assert.equal(E.sourceOf(m.get('mood:sad')), 'audio_analysis');
  assert.equal(E.sourceOf(m.get('language:hindi')), 'llm_inference');
});
