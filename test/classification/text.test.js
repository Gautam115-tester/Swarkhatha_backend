'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const t = require('../../lib/classification/text');

const slugs = (s, o) => t.parseTitle(s, o).versions.map((v) => v.slug).sort();

test('version markers are read only where uploaders put them', () => {
  assert.deepEqual(slugs('Shayad - Reprise'), ['reprise']);
  assert.deepEqual(slugs('Shayad Reprise'), ['reprise']);
  assert.deepEqual(slugs('Tum Hi Ho (Unplugged)'), ['unplugged']);
  assert.deepEqual(slugs('Raabta (Slowed + Reverb)'), ['slowed-reverb']);
  assert.deepEqual(slugs('Kesariya (Lofi)'), ['lo-fi-version']);
  assert.deepEqual(slugs('Kal Ho Naa Ho - Female Version'), ['female-version']);
  assert.deepEqual(slugs('Tera Ban Jaunga (DJ Chetas Remix)'), ['remix']);
  assert.deepEqual(slugs('Shape of You (Live at Wembley)'), ['live-version']);
  assert.deepEqual(slugs('Song (Radio Edit)'), ['radio-edit']);
  assert.deepEqual(slugs('Song (Remastered 2011)'), ['remastered-version']);
  assert.deepEqual(slugs('Song (Sped Up)'), ['sped-up-version']);
  assert.deepEqual(slugs('Song (Club Mix)'), ['club-mix']);
});

test('ordinary titles that merely contain a keyword are not versions', () => {
  assert.deepEqual(slugs('Live Your Life'), []);
  assert.deepEqual(slugs('Cover Me In Sunshine'), []);
  assert.deepEqual(slugs('Slow Down'), []);
  assert.deepEqual(slugs('Dil Se.mp3'), []);
});

test('film hint, base title and album-level markers', () => {
  const p = t.parseTitle('Shayad (From "Love Aaj Kal")');
  assert.equal(p.base, 'Shayad');
  assert.equal(p.film, 'Love Aaj Kal');
  assert.equal(t.parseTitle('Chaiyya Chaiyya (Original Motion Picture Soundtrack)').film, '(soundtrack)');
  const viaAlbum = t.parseTitle('Kesariya', { album: 'Brahmastra (Remix)' }).versions;
  assert.deepEqual(viaAlbum.map((v) => [v.slug, v.via]), [['remix', 'album']]);
  assert.ok(viaAlbum[0].p < 0.9);
});

test('all versions of a song share a composition key', () => {
  const k = (s) => t.compositionKey(t.parseTitle(s).base);
  assert.equal(k('Shayad'), k('Shayad (Reprise)'));
  assert.equal(k('Shayad'), k('Shayad - Female Version'));
  assert.notEqual(k('Shayad'), k('Shayari'));
});

test('artist splitting', () => {
  assert.deepEqual(t.splitArtists('Arijit Singh, Shreya Ghoshal & Pritam feat. X ft. Y'), ['Arijit Singh', 'Shreya Ghoshal', 'Pritam', 'X', 'Y']);
  assert.deepEqual(t.splitArtists('  '), []);
});

test('sanitize strips control and zero-width characters and caps length', () => {
  assert.equal(t.sanitize('A\u0000B\u200bC\n\tD'), 'A B C D');
  assert.equal(t.sanitize('x'.repeat(1000)).length, 300);
});

test('language from script is never guessed from nationality', () => {
  assert.equal(t.languageFromText('என் உயிரே நீ இல்லாமல் நான் இல்லை என் உயிரே', 'lyrics')[0].slug, 'tamil');
  assert.equal(t.languageFromText('ਤੇਰੇ ਬਿਨਾ ਦਿਲ ਨਹੀਂ ਲੱਗਦਾ ਮੇਰਾ', 'lyrics')[0].slug, 'punjabi');
  assert.deepEqual(t.languageFromText('Shayad', 'title'), []); // Latin short text: can't tell
});

test('Devanagari: Hindi vs Marathi decided by function words, ambiguous otherwise', () => {
  const hi = t.languageFromText('तेरे बिना मैं नहीं है दिल में कि और तुम को का की के', 'lyrics');
  assert.equal(hi[0].slug, 'hindi'); assert.ok(hi[0].p > 0.85);
  const mr = t.languageFromText('मी तुला पाहिलं आहे माझ्या मनात काय आहे नाही आणि मला', 'lyrics');
  assert.equal(mr[0].slug, 'marathi');
  const amb = t.languageFromText('तेरे बिना ज़िन्दगी', 'title');
  assert.ok(amb[0].p <= 0.5, 'a Devanagari title alone must stay weak');
});

test('Latin lyrics: English vs romanised Hindi', () => {
  const en = Array(12).fill('I love you and you know that I am with you the whole time').join(' ');
  assert.equal(t.languageFromText(en, 'lyrics')[0].slug, 'english');
  const roman = Array(12).fill('tu hai to main hoon tere bina dil nahi lagta mera hai kya').join(' ');
  assert.equal(t.languageFromText(roman, 'lyrics')[0].slug, 'hindi');
});

test('similarity', () => {
  assert.equal(t.similarity('Tum Hi Ho', 'tum hi ho!'), 1);
  assert.ok(t.similarity('Shayad', 'Shayari') < 0.82);
  assert.equal(t.similarity('', 'x'), 0);
});
