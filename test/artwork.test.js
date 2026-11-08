'use strict';
process.env.JWT_SECRET = 'test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { create } = require('./fakeSupabase');

// Swap the real Supabase client + Drime-backed collaborators BEFORE loading routes.
const fake = create();
const stub = (relPath, exports) => {
  const p = require.resolve(relPath);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../lib/supabaseClient', fake);
stub('../lib/autoCategorize', { autoCategorizeIfMissing: async () => {}, backfillMissingCategories: async () => {} });

// A fake Drime: records every upload/delete, with latency so concurrency is real.
const drimeLog = { uploads: [], deleted: [] };
let fileSeq = 0;
const fakeCoverStorage = {
  async uploadImage({ buffer, prefix }) {
    await new Promise((r) => setTimeout(r, 15));
    fileSeq++;
    const up = { accountId: 'img-acct', storageFileId: `file-${fileSeq}`, storageHash: `hash${fileSeq}`, sizeBytes: buffer.length };
    drimeLog.uploads.push({ prefix, ...up });
    return up;
  },
  async deleteImage({ storageFileId }) { drimeLog.deleted.push(storageFileId); }
};
stub('../lib/coverImageStorage', fakeCoverStorage);

const {
  createArtworkService, normalizeKey, parseReleaseYear, sanitizeSegment
} = require('../lib/artwork');

const makeService = () => createArtworkService({
  supabase: fake, coverStorage: fakeCoverStorage, invalidateMediaItem: () => {}, parentTtlMs: 0, log: () => {}
});
const urlFor = (up) => `https://cdn.test/api/storage/cover/${up.accountId}/${up.storageHash}`;
const png = (n = 1) => Buffer.from(`image-bytes-${n}`);

function reset() {
  for (const k of Object.keys(fake.db)) fake.db[k].length = 0;
  drimeLog.uploads.length = 0;
  drimeLog.deleted.length = 0;
}

/* ------------------------------------------------------------ pure helpers */

test('parseReleaseYear reads the year from tags the way real files carry it', () => {
  assert.equal(parseReleaseYear('2020-02-14'), 2020); // the "date" tag from the Love Aaj Kal file
  assert.equal(parseReleaseYear(2009), 2009);
  assert.equal(parseReleaseYear('14/02/2020'), 2020);
  assert.equal(parseReleaseYear(new Date(Date.UTC(2009, 4, 1))), 2009);
  assert.equal(parseReleaseYear(''), null);
  assert.equal(parseReleaseYear(null), null);
  assert.equal(parseReleaseYear('unknown'), null);
  assert.equal(parseReleaseYear('1850'), null); // implausible
  assert.equal(parseReleaseYear('12020'), null); // a longer number is not a year
});

test('normalizeKey is case- and whitespace-insensitive but keeps meaningful text', () => {
  assert.equal(normalizeKey('  Love   Aaj Kal '), 'love aaj kal');
  assert.notEqual(
    normalizeKey('Love Aaj Kal'),
    normalizeKey('Love Aaj Kal (Original Motion Picture Soundtrack)')
  );
  assert.equal(sanitizeSegment('Tu_Mera: Hero?'), 'Tu Mera Hero');
});

/* ------------------------------------------------------------ album identity */

test('same album name + different release year => two separate albums', async () => {
  reset();
  const svc = makeService();
  const a2009 = await svc.ensureAlbum({ name: 'Love Aaj Kal', artist: 'Pritam', releaseYear: '2009-07-31' });
  const a2020 = await svc.ensureAlbum({ name: 'Love Aaj Kal', artist: 'Pritam', releaseYear: '2020-02-14' });
  assert.notEqual(a2009.id, a2020.id);
  assert.equal(a2009.release_year, 2009);
  assert.equal(a2020.release_year, 2020);
  assert.equal(fake.db.albums.length, 2);
});

test('same name + same year reuses ONE album regardless of artist credit or casing', async () => {
  reset();
  const svc = makeService();
  const a = await svc.ensureAlbum({ name: 'Love Aaj Kal (Original Motion Picture Soundtrack)', artist: 'Pritam', releaseYear: 2020 });
  const b = await svc.ensureAlbum({ name: 'love aaj kal (original motion picture soundtrack)', artist: 'Arijit Singh', releaseYear: '2020-02-14' });
  const c = await svc.ensureAlbum({ name: '  Love Aaj Kal (Original Motion Picture   Soundtrack) ', artist: null, releaseYear: 2020 });
  assert.equal(a.id, b.id);
  assert.equal(a.id, c.id);
  assert.equal(fake.db.albums.length, 1);
});

test('unknown year is its own identity and is never merged into a dated album', async () => {
  reset();
  const svc = makeService();
  const dated = await svc.ensureAlbum({ name: 'Rockstar', releaseYear: 2011 });
  const undated = await svc.ensureAlbum({ name: 'Rockstar' });
  const undated2 = await svc.ensureAlbum({ name: 'Rockstar', releaseYear: '' });
  assert.notEqual(dated.id, undated.id);
  assert.equal(undated.id, undated2.id);
});

test('20 simultaneous find-or-create calls for one album create exactly one row', async () => {
  reset();
  const svc = makeService();
  const rows = await Promise.all(
    Array.from({ length: 20 }, () => svc.ensureAlbum({ name: 'Aashiqui 2', artist: 'Mithoon', releaseYear: 2013 }))
  );
  assert.equal(new Set(rows.map((r) => r.id)).size, 1);
  assert.equal(fake.db.albums.length, 1);
});

test('a unique-index violation from another instance falls back to the winner row', async () => {
  reset();
  const svc = makeService();
  // Simulate "another instance inserted between our find and insert".
  const realFrom = fake.from;
  let injected = false;
  fake.from = (table) => {
    const b = realFrom(table);
    if (table === 'albums' && !injected) {
      const realInsert = b.insert;
      b.insert = (p) => {
        if (!injected) {
          injected = true;
          fake.db.albums.push({ id: fake.uuid(), name: p.name, name_key: normalizeKey(p.name), release_year: p.release_year ?? null, artist: 'winner', track_count: 0, cover_image_url: null, created_at: new Date().toISOString() });
        }
        return realInsert(p);
      };
    }
    return b;
  };
  try {
    const album = await svc.ensureAlbum({ name: 'Race Album', artist: 'me', releaseYear: 2015 });
    assert.equal(album.artist, 'winner');
    assert.equal(fake.db.albums.length, 1);
  } finally {
    fake.from = realFrom;
  }
});

test('renaming/dating an album never silently merges it into another one', async () => {
  reset();
  const svc = makeService();
  const a = await svc.ensureAlbum({ name: 'Love Aaj Kal' });
  const b = await svc.ensureAlbum({ name: 'Love Aaj Kal', releaseYear: 2020 });
  const res = await svc.updateAlbumIdentity(a.id, { releaseYear: 2020 });
  assert.equal(res.conflict.id, b.id);
  const ok = await svc.updateAlbumIdentity(a.id, { releaseYear: 2009 });
  assert.equal(ok.album.release_year, 2009);
  assert.equal(fake.db.albums.length, 2);
});

/* ------------------------------------------------------------ album artwork */

test('10 simultaneous track uploads of one album => exactly ONE Drime image, all tracks share it', async () => {
  reset();
  const svc = makeService();
  const album = await svc.ensureAlbum({ name: 'Tamasha', artist: 'A. R. Rahman', releaseYear: 2015 });
  for (let i = 0; i < 10; i++) {
    fake.db.media_items.push({ id: fake.uuid(), type: 'music', album_id: album.id, title: `t${i}`, cover_image_url: null });
  }

  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => svc.setAlbumArtworkIfMissing({ albumId: album.id, buffer: png(i), urlFor }))
  );

  assert.equal(drimeLog.uploads.length, 1, 'only one image may reach Drime');
  assert.equal(results.filter((r) => r.uploaded).length, 1);
  const urls = new Set(results.map((r) => r.album.cover_image_url));
  assert.equal(urls.size, 1);
  assert.ok([...urls][0]);

  // every track mirrors the single album image
  assert.ok(fake.db.media_items.every((m) => m.cover_image_url === [...urls][0]));
  // the album remembers exactly which Drime file it owns
  const row = fake.db.albums[0];
  assert.equal(row.image_storage_file_id, drimeLog.uploads[0].storageFileId);
  assert.equal(drimeLog.deleted.length, 0);
});

test('an album that already has artwork never triggers another upload', async () => {
  reset();
  const svc = makeService();
  const album = await svc.ensureAlbum({ name: 'Barfi', releaseYear: 2012 });
  await svc.setAlbumArtworkIfMissing({ albumId: album.id, buffer: png(1), urlFor });
  const again = await svc.setAlbumArtworkIfMissing({ albumId: album.id, buffer: png(2), urlFor });
  assert.equal(again.uploaded, false);
  assert.equal(drimeLog.uploads.length, 1);
});

test('two different albums with the same name each get their own image', async () => {
  reset();
  const svc = makeService();
  const a2009 = await svc.ensureAlbum({ name: 'Love Aaj Kal', releaseYear: 2009 });
  const a2020 = await svc.ensureAlbum({ name: 'Love Aaj Kal', releaseYear: 2020 });
  const r1 = await svc.setAlbumArtworkIfMissing({ albumId: a2009.id, buffer: png(1), urlFor });
  const r2 = await svc.setAlbumArtworkIfMissing({ albumId: a2020.id, buffer: png(2), urlFor });
  assert.equal(drimeLog.uploads.length, 2);
  assert.notEqual(r1.album.cover_image_url, r2.album.cover_image_url);
});

test('losing the compare-and-set race deletes the just-uploaded file (no orphan)', async () => {
  reset();
  const svc = makeService();
  const album = await svc.ensureAlbum({ name: 'Cross Instance', releaseYear: 2018 });
  // Another instance sets the cover while our upload is in flight.
  const realUpload = fakeCoverStorage.uploadImage;
  fakeCoverStorage.uploadImage = async (args) => {
    const up = await realUpload(args);
    Object.assign(fake.db.albums[0], { cover_image_url: 'https://other-instance/cover', image_storage_file_id: 'file-from-other-instance' });
    return up;
  };
  try {
    const res = await svc.setAlbumArtworkIfMissing({ albumId: album.id, buffer: png(1), urlFor });
    assert.equal(res.uploaded, false);
    assert.equal(res.album.cover_image_url, 'https://other-instance/cover');
    assert.deepEqual(drimeLog.deleted, [drimeLog.uploads[0].storageFileId]);
  } finally {
    fakeCoverStorage.uploadImage = realUpload;
  }
});

/* ------------------------------------------------------------ read path */

test('catalog reads resolve artwork through album_id / story_series_id, ignoring stale track copies', async () => {
  reset();
  const svc = makeService();
  const album = await svc.ensureAlbum({ name: 'Wake Up Sid', releaseYear: 2009 });
  await svc.setAlbumArtworkIfMissing({ albumId: album.id, buffer: png(1), urlFor });
  const series = await svc.ensureSeries({ title: 'Tu Mera Hero No Zero' });
  await svc.setSeriesArtwork({ seriesId: series.id, buffer: png(2), urlFor });

  const items = [
    { id: 't1', type: 'music', album_id: album.id, cover_image_url: 'https://stale/one.jpg' },
    { id: 't2', type: 'music', album_id: album.id, cover_image_url: null },
    { id: 'e1', type: 'audio_story', story_series_id: series.id, cover_image_url: 'https://stale/two.jpg' },
    { id: 'x', type: 'music', album_id: null, cover_image_url: 'https://legacy/single.jpg' }
  ];
  const out = await svc.applyArtwork(items);
  const albumUrl = fake.db.albums[0].cover_image_url;
  const seriesUrl = fake.db.story_series[0].cover_image_url;
  assert.equal(out[0].cover_image_url, albumUrl);
  assert.equal(out[1].cover_image_url, albumUrl);
  assert.equal(out[0].release_year, 2009);
  assert.equal(out[2].cover_image_url, seriesUrl);
  assert.equal(out[3].cover_image_url, 'https://legacy/single.jpg'); // untouched singles keep their own
});

/* ------------------------------------------------------------ series */

test('series are identified by title: "Tu Mera Hero No Zero" never duplicates', async () => {
  reset();
  const svc = makeService();
  const rows = await Promise.all([
    svc.ensureSeries({ title: 'Tu Mera Hero No Zero', narrator: 'A' }),
    svc.ensureSeries({ title: 'tu mera hero no zero' }),
    svc.ensureSeries({ title: '  Tu  Mera Hero No Zero ' }),
    svc.ensureSeries({ title: 'Tu Mera Hero' }) // different series that merely starts the same
  ]);
  assert.equal(rows[0].id, rows[1].id);
  assert.equal(rows[0].id, rows[2].id);
  assert.notEqual(rows[0].id, rows[3].id);
  assert.equal(fake.db.story_series.length, 2);
});

test('replacing a series image mirrors it to all episodes and deletes the old file', async () => {
  reset();
  const svc = makeService();
  const series = await svc.ensureSeries({ title: 'Mahabharat' });
  for (let i = 1; i <= 5; i++) fake.db.media_items.push({ id: fake.uuid(), story_series_id: series.id, chapter_number: i, cover_image_url: null });

  await svc.setSeriesArtwork({ seriesId: series.id, buffer: png(1), urlFor });
  const first = drimeLog.uploads[0];
  const second = await svc.setSeriesArtwork({ seriesId: series.id, buffer: png(2), urlFor });

  assert.equal(drimeLog.uploads.length, 2);
  assert.deepEqual(drimeLog.deleted, [first.storageFileId]); // old one removed after the swap
  assert.ok(fake.db.media_items.every((m) => m.cover_image_url === second.series.cover_image_url));
});

test('a replaced image is NOT deleted while another series still references it', async () => {
  reset();
  const svc = makeService();
  const s1 = await svc.ensureSeries({ title: 'Series One' });
  const s2 = await svc.ensureSeries({ title: 'Series Two' });
  await svc.setSeriesArtwork({ seriesId: s1.id, buffer: png(1), urlFor });
  // s2 points at the very same Drime file (e.g. same picture)
  Object.assign(fake.db.story_series[1], { image_storage_file_id: drimeLog.uploads[0].storageFileId });
  await svc.setSeriesArtwork({ seriesId: s1.id, buffer: png(2), urlFor });
  assert.deepEqual(drimeLog.deleted, []);
});

/* ------------------------------------------------------------ legacy-client safety net */

test('legacy per-track cover uploads are discarded unless something references them', async () => {
  reset();
  const svc = makeService();
  const album = await svc.ensureAlbum({ name: 'Legacy', releaseYear: 2010 });
  await svc.setAlbumArtworkIfMissing({ albumId: album.id, buffer: png(1), urlFor });
  const owned = fake.db.albums[0].image_storage_file_id;

  assert.equal(await svc.discardRedundantUpload({ accountId: 'img-acct', storageFileId: owned }), false); // the album's own file
  assert.equal(await svc.discardRedundantUpload({ accountId: 'img-acct', storageFileId: 'duplicate-file' }), true);
  assert.deepEqual(drimeLog.deleted, ['duplicate-file']);
});

test('counts are recomputed from rows, not incremented', async () => {
  reset();
  const svc = makeService();
  const album = await svc.ensureAlbum({ name: 'Counted', releaseYear: 2000 });
  for (let i = 0; i < 3; i++) fake.db.media_items.push({ id: fake.uuid(), album_id: album.id });
  assert.equal(await svc.recountAlbum(album.id), 3);
  fake.db.media_items.pop();
  assert.equal(await svc.recountAlbum(album.id), 2);
  assert.equal(fake.db.albums[0].track_count, 2);
});

/* ------------------------------------------------------------ HTTP: the whole upload flow */

async function startApp() {
  // Load AFTER the stubs above so the default artwork instance uses the fakes.
  const artworkMod = require('../lib/artwork');
  const real = createArtworkService({
    supabase: fake, coverStorage: fakeCoverStorage, invalidateMediaItem: () => {}, parentTtlMs: 0, log: () => {}
  });
  artworkMod.getDefault = () => real; // routes/media.js calls getDefault() at require time
  delete require.cache[require.resolve('../routes/media')];
  const mediaRoutes = require('../routes/media');
  const app = express();
  app.use(express.json());
  app.use('/api/media', mediaRoutes);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  return { server, base: `http://127.0.0.1:${server.address().port}/api/media` };
}

const adminToken = jwt.sign({ sub: 'admin-1', email: 'a@x.com', role: 'admin' }, process.env.JWT_SECRET);
const auth = { Authorization: `Bearer ${adminToken}` };
const jsonHeaders = { ...auth, 'Content-Type': 'application/json' };

function trackBody(over) {
  return {
    type: 'music', title: 'Track', artistOrNarrator: 'Artist', albumOrSeries: 'Love Aaj Kal',
    durationSeconds: 200, fileSizeBytes: 1000, storageProvider: 'drime', storageAccountId: 'aud-acct',
    storageFileId: `aud-${Math.random()}`, storageHash: `h-${Math.random()}`, storagePath: '/x.mp3', ...over
  };
}

test('HTTP: Love Aaj Kal 2009 and 2020 become two albums with two images; tracks share theirs', async () => {
  reset();
  const { server, base } = await startApp();
  try {
    const img = (n) => { const f = new FormData(); f.append('image', new Blob([png(n)]), 'cover.jpg'); return f; };

    // Album A: 2009 — 6 tracks uploaded "simultaneously", each attempting to send art.
    const a = (await (await fetch(`${base}/albums/resolve`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ name: 'Love Aaj Kal', artist: 'Pritam', releaseYear: 2009 }) })).json()).album;
    await Promise.all(Array.from({ length: 6 }, (_, i) =>
      fetch(`${base}/albums/${a.id}/artwork`, { method: 'PUT', headers: auth, body: img(i) })
    ));
    for (let i = 0; i < 6; i++) {
      const r = await fetch(`${base}/`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(trackBody({ title: `old ${i}`, albumId: a.id })) });
      assert.equal(r.status, 200);
    }

    // Album B: 2020 — name from the real file tags, year from the "date" tag.
    const b = (await (await fetch(`${base}/albums/resolve`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ name: 'Love Aaj Kal (Original Motion Picture Soundtrack)', artist: 'Pritam', releaseYear: '2020-02-14' }) })).json()).album;
    // Same-named, same-year second album resolve must return the same one:
    const bAgain = (await (await fetch(`${base}/albums/resolve`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ name: 'Love Aaj Kal (Original Motion Picture Soundtrack)', artist: 'Arijit', releaseYear: 2020 }) })).json()).album;
    assert.equal(bAgain.id, b.id);
    assert.equal(b.hasArtwork, false);
    await fetch(`${base}/albums/${b.id}/artwork`, { method: 'PUT', headers: auth, body: img(99) });
    for (let i = 0; i < 3; i++) {
      await fetch(`${base}/`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(trackBody({ title: `new ${i}`, albumOrSeries: 'Love Aaj Kal (Original Motion Picture Soundtrack)', releaseYear: '2020-02-14' })) });
    }

    assert.equal(fake.db.albums.length, 2);
    assert.equal(drimeLog.uploads.length, 2, 'exactly one image per album reached Drime');
    assert.equal(drimeLog.deleted.length, 0);

    // The catalog the listener app downloads: every track of an album has the identical URL.
    const catalog = (await (await fetch(`${base}/?type=music`, { headers: auth })).json()).items;
    const byAlbum = new Map();
    for (const it of catalog) byAlbum.set(it.album_id, new Set([...(byAlbum.get(it.album_id) || []), it.cover_image_url]));
    assert.equal(byAlbum.size, 2);
    for (const urls of byAlbum.values()) assert.equal(urls.size, 1);
    const [urlA, urlB] = [...byAlbum.values()].map((s) => [...s][0]);
    assert.notEqual(urlA, urlB);
    assert.deepEqual(new Set(catalog.map((c) => c.release_year)), new Set([2009, 2020]));

    // Counters
    assert.deepEqual(fake.db.albums.map((x) => x.track_count).sort(), [3, 6]);
  } finally {
    server.close();
  }
});

test('HTTP: older admin build uploading a cover for every track leaves no duplicate on Drime', async () => {
  reset();
  const { server, base } = await startApp();
  try {
    // First legacy upload: album has no art -> adopted.
    const first = { coverImageUrl: 'https://cdn/c/1', coverStorageAccountId: 'img-acct', coverStorageFileId: 'legacy-1', coverStorageHash: 'l1' };
    await fetch(`${base}/`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(trackBody({ albumOrSeries: 'Legacy Album', releaseYear: 2014, ...first })) });
    // Every further track re-uploads "its own" cover: they must be removed from Drime.
    for (let i = 2; i <= 4; i++) {
      await fetch(`${base}/`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(trackBody({
        albumOrSeries: 'Legacy Album', releaseYear: 2014,
        coverImageUrl: `https://cdn/c/${i}`, coverStorageAccountId: 'img-acct', coverStorageFileId: `legacy-${i}`, coverStorageHash: `l${i}`
      })) });
    }
    assert.equal(fake.db.albums.length, 1);
    assert.equal(fake.db.albums[0].image_storage_file_id, 'legacy-1');
    assert.deepEqual(drimeLog.deleted.sort(), ['legacy-2', 'legacy-3', 'legacy-4']);
    assert.ok(fake.db.media_items.every((m) => m.cover_image_url === 'https://cdn/c/1'));
  } finally {
    server.close();
  }
});

test('HTTP: series episodes join the existing series and share its single admin-uploaded image', async () => {
  reset();
  const { server, base } = await startApp();
  try {
    const s = (await (await fetch(`${base}/stories/resolve`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ title: 'Tu Mera Hero No Zero' }) })).json()).series;
    const form = new FormData();
    form.append('image', new Blob([png(7)]), 'cover.jpg');
    const put = await fetch(`${base}/stories/${s.id}/artwork`, { method: 'PUT', headers: auth, body: form });
    assert.equal(put.status, 200);

    for (const [n, t] of [[345, '1000 crore'], [346, 'Dhamaka'], [347, null]]) {
      const r = await fetch(`${base}/`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({
        type: 'audio_story', storyTitle: 'tu mera hero no zero', chapterNumber: n, episodeTitle: t,
        storageProvider: 'drime', storageAccountId: 'aud', storageFileId: `f${n}`, storageHash: `h${n}`, storagePath: '/x'
      }) });
      assert.equal(r.status, 200);
    }
    assert.equal(fake.db.story_series.length, 1, 'no duplicate series');
    assert.equal(fake.db.story_series[0].episode_count, 3);
    assert.equal(drimeLog.uploads.length, 1, 'one image for the whole series');
    const seriesUrl = fake.db.story_series[0].cover_image_url;
    assert.ok(fake.db.media_items.every((m) => m.story_series_id === s.id && m.cover_image_url === seriesUrl));
  } finally {
    server.close();
  }
});

test('HTTP: PATCH album refuses to merge two same-named albums', async () => {
  reset();
  const { server, base } = await startApp();
  try {
    const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) }).then((r) => r.json());
    const old = (await post('/albums/resolve', { name: 'Love Aaj Kal' })).album;
    const dated = (await post('/albums/resolve', { name: 'Love Aaj Kal', releaseYear: 2020 })).album;
    const clash = await fetch(`${base}/albums/${old.id}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ releaseYear: 2020 }) });
    assert.equal(clash.status, 409);
    assert.equal((await clash.json()).conflictAlbumId, dated.id);
    const ok = await fetch(`${base}/albums/${old.id}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ releaseYear: 2009 }) });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).album.releaseYear, 2009);
  } finally {
    server.close();
  }
});
