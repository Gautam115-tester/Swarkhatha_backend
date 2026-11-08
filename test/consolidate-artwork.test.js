'use strict';
// End-to-end run of scripts/consolidate-artwork.js against fakes: DB + Drime.
const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('./fakeSupabase');

const fake = create();
const stub = (relPath, exports) => {
  const p = require.resolve(relPath);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../lib/supabaseClient', fake);
stub('../lib/crypto', { decrypt: () => JSON.stringify({ accessToken: 't', workspaceId: 0, folderId: null }), encrypt: (x) => x });

const OLD = '2020-01-01T00:00:00Z';
const u = (h) => `https://cdn.test/api/storage/cover/img-1/${h}`;
let entries; let deleted;
stub('../lib/drime', {
  async listEntries() { return { data: entries, last_page: 1, total: entries.length }; },
  async deleteFile({ fileEntryId }) { deleted.push(String(fileEntryId)); }
});

function seed() {
  for (const k of Object.keys(fake.db)) fake.db[k].length = 0;
  deleted = [];
  const e = (id, name, hash, created = OLD) => ({ id, name, hash, created_at: created, file_size: 1000 });
  entries = [
    e(1, 'album-1.jpg', 'H1'), e(2, 'album-2.jpg', 'H2'), e(3, 'album-3.jpg', 'H3'), e(4, 'album-4.jpg', 'H4'),
    e(5, 'album-5.jpg', 'H5'), e(6, 'album-6.jpg', 'H6'), e(7, 'story-7.jpg', 'H7'), e(8, 'story-8.jpg', 'H8'),
    e(9, 'album-9.jpg', 'H9', new Date().toISOString()), // brand new: could still be mid-registration
    e(10, 'holiday.jpg', 'H10'),                          // not ours
    e(11, 'album-11.jpg', 'H11')                          // a single's own cover, no album
  ];
  fake.db.storage_accounts.push({ id: 'img-1', purpose: 'image', is_active: true, label: 'imgs', credentials_enc: 'x' });
  const A = (id, name, artist, year, h, file, n, created) => ({
    id, name, artist, release_year: year, cover_image_url: u(h), image_storage_account_id: 'img-1',
    image_storage_file_id: String(file), image_storage_hash: h, track_count: n, created_at: created
  });
  fake.db.albums.push(
    A('A1', 'Aashiqui 2', 'Mithoon', null, 'H1', 1, 2, '2024-01-01'),
    A('A2', 'Aashiqui 2', 'Arijit Singh', null, 'H2', 2, 1, '2024-01-02'), // same album split by artist
    A('Y09', 'Love Aaj Kal', 'Pritam', 2009, 'H5', 5, 1, '2024-01-03'),
    A('Y20', 'Love Aaj Kal', 'Pritam', 2020, 'H6', 6, 1, '2024-01-04')     // same name, other year: stays separate
  );
  const T = (id, album, cover) => ({ id, type: 'music', album_id: album, album_or_series: 'x', cover_image_url: cover ? u(cover) : null });
  fake.db.media_items.push(T('t1', 'A1', 'H3'), T('t2', 'A1', 'H1'), T('t3', 'A2', 'H4'), T('t4', 'Y09', 'H5'), T('t5', 'Y20', 'H6'), T('s1', null, 'H11'));
  fake.db.story_series.push(
    { id: 'S1', title: 'Mahabharat', cover_image_url: u('H7'), image_storage_account_id: 'img-1', image_storage_file_id: '7', image_storage_hash: 'H7', episode_count: 1, created_at: '2024-01-01' },
    { id: 'S2', title: 'mahabharat', cover_image_url: null, episode_count: 1, created_at: '2024-01-02' }
  );
  fake.db.media_items.push(
    { id: 'e1', type: 'audio_story', story_series_id: 'S1', cover_image_url: null },
    { id: 'e2', type: 'audio_story', story_series_id: 'S2', cover_image_url: u('H8') }
  );
  fake.db.story_follows.push({ user_id: 'u1', series_key: 'Mahabharat', series_title: 'Mahabharat', cover_image_url: u('H8') });
}

async function runScript(flags) {
  process.argv = ['node', 'consolidate-artwork.js', ...flags];
  const p = require.resolve('../scripts/consolidate-artwork.js');
  delete require.cache[p];
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try { await require(p).main(); } finally { console.log = orig; }
  return logs.join('\n');
}

test('dry run changes nothing and projects the files it would delete', async () => {
  seed();
  const before = JSON.stringify(fake.db);
  const out = await runScript([]);
  assert.equal(JSON.stringify(fake.db), before, 'database untouched');
  assert.deepEqual(deleted, [], 'Drime untouched');
  for (const name of ['album-2.jpg', 'album-3.jpg', 'album-4.jpg', 'story-8.jpg']) assert.match(out, new RegExp(`would delete ${name.replace('.', '\\.')}`));
  for (const name of ['album-1.jpg', 'album-5.jpg', 'album-6.jpg', 'story-7.jpg', 'album-9.jpg', 'holiday.jpg', 'album-11.jpg']) {
    assert.doesNotMatch(out, new RegExp(`would delete ${name.replace('.', '\\.')}`));
  }
  assert.match(out, /keeping SEPARATE \(different release years\): "Love Aaj Kal"/);
});

test('--confirm merges same-name+same-year, never merges different years, then deletes only unreferenced files', async () => {
  seed();
  await runScript(['--confirm']);

  // albums: Aashiqui 2 collapsed to one, both Love Aaj Kal editions survive
  const names = fake.db.albums.map((a) => `${a.name}|${a.release_year}`).sort();
  assert.deepEqual(names, ['Aashiqui 2|null', 'Love Aaj Kal|2009', 'Love Aaj Kal|2020']);
  const a1 = fake.db.albums.find((a) => a.id === 'A1');
  assert.equal(a1.track_count, 3);
  assert.ok(fake.db.media_items.filter((m) => ['t1', 't2', 't3'].includes(m.id)).every((m) => m.album_id === 'A1' && m.cover_image_url === u('H1')));
  assert.equal(fake.db.media_items.find((m) => m.id === 't4').cover_image_url, u('H5'));
  assert.equal(fake.db.media_items.find((m) => m.id === 't5').cover_image_url, u('H6'));
  assert.equal(fake.db.media_items.find((m) => m.id === 's1').cover_image_url, u('H11')); // singles untouched

  // series merged, episodes + follow share the single image
  assert.equal(fake.db.story_series.length, 1);
  assert.equal(fake.db.story_series[0].episode_count, 2);
  assert.ok(fake.db.media_items.filter((m) => m.story_series_id).every((m) => m.story_series_id === 'S1' && m.cover_image_url === u('H7')));
  assert.equal(fake.db.story_follows[0].cover_image_url, u('H7'));

  // Drime: exactly the unreferenced, old, ours files are gone
  assert.deepEqual(deleted.sort(), ['2', '3', '4', '8']);
});

test('a second --confirm run is a no-op (idempotent)', async () => {
  seed();
  await runScript(['--confirm']);
  const snapshot = JSON.stringify(fake.db);
  deleted.length = 0;
  entries = entries.filter((e) => !['2', '3', '4', '8'].includes(String(e.id)));
  await runScript(['--confirm']);
  assert.equal(JSON.stringify(fake.db), snapshot);
  assert.deepEqual(deleted, []);
});
