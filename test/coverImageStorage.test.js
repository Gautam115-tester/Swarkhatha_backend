'use strict';
// The real coverImageStorage (real sharp), with Drime + Supabase stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { create } = require('./fakeSupabase');

const fake = create();
const stub = (relPath, exports) => {
  const p = require.resolve(relPath);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../lib/supabaseClient', fake);
stub('../lib/crypto', { decrypt: () => JSON.stringify({ accessToken: 't', workspaceId: 0, folderId: null }), encrypt: (x) => x });

const calls = { uploads: [], deletes: [] };
let seq = 0;
stub('../lib/drime', {
  async uploadFile({ buffer, fileName }) {
    await new Promise((r) => setTimeout(r, 20));
    seq++;
    calls.uploads.push(fileName);
    return { fileEntryId: `entry-${seq}`, hash: `hash-${seq}`, fileName, fileSizeBytes: buffer.length };
  },
  async deleteFile({ fileEntryId }) { calls.deletes.push(fileEntryId); }
});

const storage = require('../lib/coverImageStorage');

const image = (color) => sharp({ create: { width: 64, height: 64, channels: 3, background: color } }).png().toBuffer();

test.beforeEach(() => {
  fake.db.storage_accounts.length = 0;
  fake.db.albums.length = 0;
  fake.db.story_series.length = 0;
  fake.db.storage_accounts.push({ id: 'img-1', purpose: 'image', is_active: true, label: 'imgs', credentials_enc: 'x', last_known_free_bytes: 1e9 });
  calls.uploads.length = 0;
  calls.deletes.length = 0;
});

test('identical cover bytes uploaded simultaneously are stored on Drime exactly once', async () => {
  const red = await image('#ff0000');
  const results = await Promise.all(Array.from({ length: 8 }, () => storage.uploadImage({ buffer: red, prefix: 'album' })));
  assert.equal(calls.uploads.length, 1);
  assert.equal(new Set(results.map((r) => r.storageFileId)).size, 1);
  assert.equal(results.filter((r) => !r.reused).length, 1);
});

test('a later identical upload reuses the stored file instead of writing another copy', async () => {
  const blue = await image('#0000ff');
  const first = await storage.uploadImage({ buffer: blue, prefix: 'album' });
  const second = await storage.uploadImage({ buffer: blue, prefix: 'album' });
  assert.equal(calls.uploads.length, 1);
  assert.equal(second.storageFileId, first.storageFileId);
  assert.equal(second.reused, true);
});

test('different pictures are different files', async () => {
  const a = await storage.uploadImage({ buffer: await image('#00ff00'), prefix: 'album' });
  const b = await storage.uploadImage({ buffer: await image('#ffff00'), prefix: 'album' });
  assert.notEqual(a.storageFileId, b.storageFileId);
  assert.equal(calls.uploads.length, 2);
});

test('a deleted file is never handed out again', async () => {
  const pink = await image('#ff00ff');
  const first = await storage.uploadImage({ buffer: pink, prefix: 'story' });
  await storage.deleteImage({ accountId: 'img-1', storageFileId: first.storageFileId });
  const again = await storage.uploadImage({ buffer: pink, prefix: 'story' });
  assert.notEqual(again.storageFileId, first.storageFileId);
  assert.equal(calls.uploads.length, 2);
  assert.deepEqual(calls.deletes, [first.storageFileId]);
});
