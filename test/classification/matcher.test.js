'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { matchRecording, pickBest } = require('../../lib/classification/matcher');
const { load } = require('../../lib/classification/config');
const { parseTitle, splitArtists } = require('../../lib/classification/text');

const cfg = load({});
const mk = (title, artist, extra = {}) => {
  const parsed = parseTitle(title);
  return { base: parsed.base, artists: splitArtists(artist), durationSec: 241, album: null, versionSlugs: new Set(parsed.versions.map((v) => v.slug)), ...extra };
};

test('exact recording: same title, artist, duration', () => {
  const m = matchRecording(mk('Shayad', 'Arijit Singh'), { title: 'Shayad', artists: ['Arijit Singh'], durationSec: 242 }, cfg);
  assert.equal(m.accepted, true); assert.equal(m.scope, 'recording'); assert.ok(m.confidence > 0.95);
});

test('never matches on title alone', () => {
  assert.equal(matchRecording(mk('Shayad', ''), { title: 'Shayad', artists: ['Arijit Singh'], durationSec: 241 }, cfg).accepted, false);
  const wrongArtist = matchRecording(mk('Shayad', 'Arijit Singh'), { title: 'Shayad', artists: ['Someone Else'], durationSec: 241 }, cfg);
  assert.equal(wrongArtist.accepted, false); assert.match(wrongArtist.reason, /artist/);
});

test('similar-but-different title is rejected', () => {
  assert.equal(matchRecording(mk('Shayad', 'Arijit Singh'), { title: 'Shayari', artists: ['Arijit Singh'] }, cfg).accepted, false);
});

test('our Reprise vs the provider\'s original: composition scope only, reduced confidence', () => {
  const m = matchRecording(mk('Shayad (Reprise)', 'Arijit Singh'), { title: 'Shayad', artists: ['Arijit Singh'], durationSec: 241 }, cfg);
  assert.equal(m.accepted, true); assert.equal(m.scope, 'composition'); assert.equal(m.versionsAgree, false);
  const rec = matchRecording(mk('Shayad', 'Arijit Singh'), { title: 'Shayad', artists: ['Arijit Singh'], durationSec: 241 }, cfg);
  assert.ok(m.confidence < rec.confidence * 0.9);
});

test('same version marker on both sides stays recording scope', () => {
  const m = matchRecording(mk('Shayad (Reprise)', 'Arijit Singh'), { title: 'Shayad - Reprise', artists: ['Arijit Singh'], durationSec: 240 }, cfg);
  assert.equal(m.scope, 'recording');
});

test('MusicBrainz disambiguation counts as a version marker', () => {
  const m = matchRecording(mk('Shayad', 'Arijit Singh'), { title: 'Shayad', artists: ['Arijit Singh'], durationSec: 241, disambiguation: 'acoustic version' }, cfg);
  assert.equal(m.scope, 'composition');
});

test('a very different duration means a different take: composition scope', () => {
  const m = matchRecording(mk('Shayad', 'Arijit Singh'), { title: 'Shayad', artists: ['Arijit Singh'], durationSec: 400 }, cfg);
  assert.equal(m.scope, 'composition');
});

test('missing duration lowers confidence but can still match', () => {
  const withD = matchRecording(mk('Shayad', 'Arijit Singh'), { title: 'Shayad', artists: ['Arijit Singh'], durationSec: 241 }, cfg);
  const noD = matchRecording(mk('Shayad', 'Arijit Singh'), { title: 'Shayad', artists: ['Arijit Singh'] }, cfg);
  assert.equal(noD.accepted, true); assert.ok(noD.confidence < withD.confidence);
});

test('pickBest prefers a recording-scope candidate over a composition-scope one', () => {
  const best = pickBest(mk('Shayad', 'Arijit Singh'), [
    { id: 'a', title: 'Shayad - Remix', artists: ['Arijit Singh'], durationSec: 241 },
    { id: 'b', title: 'Shayad', artists: ['Arijit Singh'], durationSec: 241 }
  ], cfg);
  assert.equal(best.candidate.id, 'b');
  assert.equal(pickBest(mk('Shayad', 'Arijit Singh'), [{ title: 'Other', artists: ['X'] }], cfg), null);
});
