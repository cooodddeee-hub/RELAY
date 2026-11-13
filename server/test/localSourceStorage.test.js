import test from 'node:test';
import assert from 'node:assert/strict';
import { assertLocalSourceAvailable, deleteLocalSourceSafely, LocalSourceUnavailableError, localDiskUploadDisabled } from '../src/services/localSourceStorage.js';

test('production and Vercel environments disable local-disk uploads', () => {
  assert.equal(localDiskUploadDisabled({ NODE_ENV: 'production' }), true);
  assert.equal(localDiskUploadDisabled({ VERCEL: '1', NODE_ENV: 'development' }), true);
  assert.equal(localDiskUploadDisabled({ NODE_ENV: 'development' }), false);
});

test('missing local original produces an explicit unavailable result', async () => {
  await assert.rejects(assertLocalSourceAvailable('', { access: async () => {} }), LocalSourceUnavailableError);
  await assert.rejects(assertLocalSourceAvailable('missing.txt', { access: async () => { const error = new Error(); error.code = 'ENOENT'; throw error; } }), LocalSourceUnavailableError);
});

test('missing local original never deletes the MongoDB source record', async () => {
  let recordDeleted = false;
  const source = { storagePath: 'missing.txt', async deleteOne() { recordDeleted = true; } };
  await assert.rejects(deleteLocalSourceSafely(source, { unlink: async () => { const error = new Error(); error.code = 'ENOENT'; throw error; } }), LocalSourceUnavailableError);
  assert.equal(recordDeleted, false);
});

test('present local original is deleted before its metadata record', async () => {
  const events = [];
  const source = { storagePath: 'present.txt', async deleteOne() { events.push('record'); } };
  await deleteLocalSourceSafely(source, { unlink: async () => { events.push('file'); } });
  assert.deepEqual(events, ['file', 'record']);
});
