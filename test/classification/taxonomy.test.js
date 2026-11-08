'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const T = require('../../lib/classification/taxonomy');

test('seed_music_labels.sql is generated from the taxonomy and up to date', () => {
  execFileSync('node', [path.join(__dirname, '../../scripts/generate-music-labels-seed.js'), '--check'], { stdio: 'pipe' });
});

test('every spec dimension is present and keys are unique', () => {
  assert.deepEqual(T.DIMENSIONS, ['genre', 'mood', 'characteristic', 'vocal', 'language', 'context', 'version']);
  for (const d of T.DIMENSIONS) assert.ok(T.ALL_LABELS.some((l) => l.dimension === d), d);
  assert.equal(new Set(T.ALL_LABELS.map((l) => T.keyOf(l.dimension, l.slug))).size, T.ALL_LABELS.length);
});

test('the specified example labels exist', () => {
  for (const k of ['genre:bollywood', 'genre:ghazal', 'genre:world-music', 'mood:sensual', 'characteristic:live-recording', 'vocal:male-female-duet',
    'language:instrumental', 'context:rainy-day', 'version:slowed-reverb', 'version:radio-edit', 'version:cover-version']) assert.ok(T.get(k), k);
});

test('hierarchy: Indian Music > Film Music > Bollywood > Bollywood Romantic', () => {
  assert.deepEqual(T.ancestorsOf('genre:bollywood-romantic'), ['genre:bollywood', 'genre:film-music', 'genre:indian-music']);
});

test('synonyms map tags onto labels, per dimension', () => {
  assert.deepEqual(T.lookupSynonym('genre', 'Bollywood'), ['genre:bollywood']);
  assert.deepEqual(T.lookupSynonym('mood', 'heartbroken'), ['mood:heartbreak']);
  assert.deepEqual(T.lookupSynonym('language', 'hin'), ['language:hindi']);
  assert.deepEqual(T.lookupSynonym('language', 'zxx'), ['language:instrumental']);
  assert.deepEqual(T.lookupSynonym('genre', 'seen live'), []);
});

test('competitors: one lead vocal / one language; Original vs every other version', () => {
  assert.ok(T.competitorsOf('vocal:male-vocal').includes('vocal:female-vocal'));
  assert.ok(!T.competitorsOf('vocal:male-vocal').includes('vocal:rap-vocal'));
  assert.ok(T.competitorsOf('language:hindi').includes('language:marathi'));
  assert.ok(T.competitorsOf('version:original').includes('version:remix'));
  assert.deepEqual(T.competitorsOf('version:remix'), ['version:original']);
  assert.deepEqual(T.competitorsOf('mood:happy'), []);
});

test('legacy content_labels names map to genres and back', () => {
  assert.equal(T.legacyNameToKey('Bollywood'), 'genre:bollywood');
  assert.equal(T.legacyNameToKey(' classical '), 'genre:classical');
  assert.equal(T.legacyNameToKey('Mythology'), null);
  assert.equal(T.legacyNameForKey('genre:bollywood'), 'Bollywood');
  assert.equal(T.legacyNameForKey('genre:hindustani-classical'), 'Classical');
  assert.equal(T.legacyNameForKey('genre:jazz'), null);
});
