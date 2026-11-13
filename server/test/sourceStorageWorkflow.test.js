import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SOURCE_SIZE,
  SourceWorkflowError,
  assertSourceReadAccess,
  completeSourceUpload,
  createSourceDownloadUrl,
  createSourceUploadIntent,
  deleteSupabaseSource,
  validateSourceUpload,
} from '../src/services/sourceStorageWorkflow.js';
import { readSupabaseStorageConfig, SupabaseStorageConfigurationError } from '../src/services/supabaseStorage.js';
import { extractTextFromBuffer } from '../src/services/documentText.js';

const ownerId = 'owner-1';
const viewerId = 'viewer-1';
const project = { _id: 'project-1', owner: ownerId, members: [{ user: viewerId, role: 'viewer' }] };
const owner = { _id: ownerId };
const file = { originalName: 'handover.txt', mimeType: 'text/plain', size: 15 };

function makeSourceModel() {
  const records = new Map();
  let nextId = 0;
  return {
    records,
    async create(values) {
      const source = {
        ...values,
        _id: `source-${++nextId}`,
        async save() { records.set(String(this._id), this); return this; },
        async deleteOne() { records.delete(String(this._id)); },
      };
      records.set(String(source._id), source);
      return source;
    },
    async findById(id) { return records.get(String(id)) || null; },
    async findOneAndUpdate(filter, update) {
      const source = records.get(String(filter._id));
      if (!source || source.storageProvider !== filter.storageProvider || source.uploadedBy !== filter.uploadedBy) return null;
      const allowedStatuses = filter.uploadStatus.$in || [filter.uploadStatus];
      if (!allowedStatuses.includes(source.uploadStatus)) return null;
      Object.assign(source, update.$set);
      return source;
    },
  };
}

function makeStorage({ bytes = Buffer.from('hello from source'), actualSize, failInfo, failDownload, failSign, failRemove } = {}) {
  const calls = { uploadSign: [], info: [], download: [], downloadSign: [], remove: [] };
  const bucket = {
    calls,
    async createSignedUploadUrl(key, options) {
      calls.uploadSign.push({ key, options });
      return failSign ? { data: null, error: new Error('provider details withheld') } : { data: { signedUrl: 'https://storage.example/signed-upload?token=ephemeral' }, error: null };
    },
    async info(key) {
      calls.info.push(key);
      return failInfo ? { data: null, error: new Error('provider details withheld') } : { data: { size: actualSize ?? bytes.length }, error: null };
    },
    async download(key) {
      calls.download.push(key);
      return failDownload ? { data: null, error: new Error('provider details withheld') } : { data: new Blob([bytes]), error: null };
    },
    async createSignedUrl(key, ttl, options) {
      calls.downloadSign.push({ key, ttl, options });
      return { data: { signedUrl: 'https://storage.example/signed-download?token=ephemeral' }, error: null };
    },
    async remove(keys) {
      calls.remove.push(keys);
      return failRemove ? { data: null, error: new Error('provider details withheld') } : { data: [], error: null };
    },
  };
  return { bucket, bucketName: 'relay-files' };
}

test('upload intent requires an owner/editor and validates extension, MIME type, and the 15 MiB limit', async () => {
  const SourceModel = makeSourceModel();
  const storageConfig = makeStorage();
  await assert.rejects(
    createSourceUploadIntent({ project, user: { _id: viewerId }, metadata: file, SourceModel, storageConfig }),
    (error) => error instanceof SourceWorkflowError && error.status === 403,
  );
  assert.equal(storageConfig.bucket.calls.uploadSign.length, 0);

  assert.throws(() => validateSourceUpload({ ...file, originalName: 'notes.exe' }), /Only PDF, DOCX, TXT and MD/);
  assert.throws(() => validateSourceUpload({ ...file, mimeType: 'application/pdf' }), /does not match/);
  assert.throws(() => validateSourceUpload({ ...file, size: MAX_SOURCE_SIZE + 1 }), /15 MiB/);
  assert.deepEqual(validateSourceUpload({ originalName: 'folder\\notes.md', mimeType: 'text/markdown', size: 2 }), {
    originalName: 'notes.md', extension: '.md', mimeType: 'text/markdown', size: 2,
  });
});

test('owner upload intent persists an unpredictable object key and only returns a signed URL capability', async () => {
  const SourceModel = makeSourceModel();
  const storageConfig = makeStorage();
  const result = await createSourceUploadIntent({
    project, user: owner, metadata: file, SourceModel, storageConfig, uuid: () => 'random-object-id', now: () => 1000,
  });
  assert.equal(result.source.storageProvider, 'supabase');
  assert.equal(result.source.storageBucket, 'relay-files');
  assert.equal(result.source.storageKey, 'project-1/random-object-id.txt');
  assert.equal(result.source.storagePath, undefined);
  assert.equal(result.source.uploadStatus, 'pending');
  assert.equal(result.source.uploadIntentExpiresAt.getTime(), 1000 + 2 * 60 * 60 * 1000);
  assert.equal(result.uploadUrl, 'https://storage.example/signed-upload?token=ephemeral');
  assert.equal(Object.hasOwn(result, 'token'), false);
  assert.deepEqual(storageConfig.bucket.calls.uploadSign[0].options, { upsert: false });
});

test('Supabase configuration fails safely without returning any configured values', () => {
  assert.throws(() => readSupabaseStorageConfig({ SUPABASE_URL: 'not-a-url', SUPABASE_SECRET_KEY: 'hidden', SUPABASE_STORAGE_BUCKET: 'relay-files' }), (error) => {
    assert.ok(error instanceof SupabaseStorageConfigurationError);
    assert.equal(error.status, 503);
    assert.doesNotMatch(error.message, /hidden|relay-files|not-a-url/);
    return true;
  });
  assert.deepEqual(readSupabaseStorageConfig({ SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'hidden', SUPABASE_STORAGE_BUCKET: 'relay-files' }), {
    url: 'https://project.supabase.co', secretKey: 'hidden', bucket: 'relay-files',
  });
});

test('completion verifies project role, uploader identity, object size, and extracts from the stored buffer', async () => {
  const SourceModel = makeSourceModel();
  const storageConfig = makeStorage({ bytes: Buffer.from('a verified document') });
  const { source } = await createSourceUploadIntent({ project, user: owner, metadata: { ...file, size: Buffer.byteLength('a verified document') }, SourceModel, storageConfig, uuid: () => 'completed-source' });
  let extracted;
  const result = await completeSourceUpload({
    source, project, userId: ownerId, SourceModel, storageConfig,
    extract: async (buffer, name) => { extracted = { buffer: buffer.toString(), name }; return 'extracted source text'; },
  });
  assert.equal(result.alreadyCompleted, false);
  assert.equal(result.source.status, 'processed');
  assert.equal(result.source.uploadStatus, 'completed');
  assert.equal(result.source.extractedText, 'extracted source text');
  assert.deepEqual(extracted, { buffer: 'a verified document', name: 'handover.txt' });
  assert.equal(storageConfig.bucket.calls.info.length, 1);
  assert.equal(storageConfig.bucket.calls.download.length, 1);

  await assert.rejects(
    completeSourceUpload({ source: result.source, project, userId: viewerId, SourceModel, storageConfig }),
    (error) => error instanceof SourceWorkflowError && error.status === 403,
  );
  await assert.rejects(
    completeSourceUpload({ source: result.source, project, userId: 'other-user', SourceModel, storageConfig }),
    (error) => error instanceof SourceWorkflowError && error.status === 403,
  );
});

test('missing, oversized, or mismatched objects fail verification without processing', async () => {
  const SourceModel = makeSourceModel();
  const metadata = { ...file, size: Buffer.byteLength('hello from source') };
  const missingConfig = makeStorage({ failInfo: true });
  const missingIntent = await createSourceUploadIntent({ project, user: owner, metadata, SourceModel, storageConfig: missingConfig, uuid: () => 'missing' });
  await assert.rejects(completeSourceUpload({ source: missingIntent.source, project, userId: ownerId, SourceModel, storageConfig: missingConfig }), (error) => error.status === 400);
  assert.equal(missingIntent.source.uploadStatus, 'failed');

  const sizeConfig = makeStorage({ actualSize: MAX_SOURCE_SIZE + 1 });
  const sizeIntent = await createSourceUploadIntent({ project, user: owner, metadata, SourceModel, storageConfig: sizeConfig, uuid: () => 'oversized' });
  await assert.rejects(completeSourceUpload({ source: sizeIntent.source, project, userId: ownerId, SourceModel, storageConfig: sizeConfig }), /size does not match/);
  assert.equal(sizeConfig.bucket.calls.download.length, 0);
});

test('duplicate completion is idempotent and does not download or extract twice', async () => {
  const SourceModel = makeSourceModel();
  const storageConfig = makeStorage();
  const { source } = await createSourceUploadIntent({ project, user: owner, metadata: { ...file, size: Buffer.byteLength('hello from source') }, SourceModel, storageConfig, uuid: () => 'duplicate' });
  let extractionCount = 0;
  const extract = async () => { extractionCount += 1; return 'text'; };
  const first = await completeSourceUpload({ source, project, userId: ownerId, SourceModel, storageConfig, extract });
  const second = await completeSourceUpload({ source: first.source, project, userId: ownerId, SourceModel, storageConfig, extract });
  assert.equal(first.alreadyCompleted, false);
  assert.equal(second.alreadyCompleted, true);
  assert.equal(extractionCount, 1);
  assert.equal(storageConfig.bucket.calls.download.length, 1);
});

test('extraction failures retain the object metadata and permit a safe completion retry', async () => {
  const SourceModel = makeSourceModel();
  const storageConfig = makeStorage();
  const { source } = await createSourceUploadIntent({ project, user: owner, metadata: { ...file, size: Buffer.byteLength('hello from source') }, SourceModel, storageConfig, uuid: () => 'retry' });
  await assert.rejects(completeSourceUpload({ source, project, userId: ownerId, SourceModel, storageConfig, extract: async () => { throw new Error('private parser detail'); } }), /Document text extraction failed/);
  assert.equal(source.uploadStatus, 'failed');
  assert.equal(source.status, 'failed');
  assert.equal(source.storageKey, 'project-1/retry.txt');
  assert.doesNotMatch(source.error, /private parser detail/);

  const retry = await completeSourceUpload({ source, project, userId: ownerId, SourceModel, storageConfig, extract: async () => 'recovered text' });
  assert.equal(retry.source.uploadStatus, 'completed');
  assert.equal(retry.source.extractedText, 'recovered text');
});

test('verified source download uses a short-lived signed URL and original filename', async () => {
  const storageConfig = makeStorage();
  const url = await createSourceDownloadUrl({ storageProvider: 'supabase', storageBucket: 'relay-files', storageKey: 'project-1/source.txt', uploadStatus: 'completed', originalName: 'handover.txt' }, { storageConfig });
  assert.match(url, /^https:\/\/storage\.example\/signed-download/);
  assert.deepEqual(storageConfig.bucket.calls.downloadSign[0], {
    key: 'project-1/source.txt', ttl: 300, options: { download: 'handover.txt' },
  });
  await assert.rejects(createSourceDownloadUrl({ storageProvider: 'supabase', storageBucket: 'relay-files', storageKey: 'pending', uploadStatus: 'pending' }, { storageConfig }), (error) => error.status === 409);
});

test('source authorization allows viewers to read but not edit', () => {
  assert.doesNotThrow(() => assertSourceReadAccess(project, viewerId));
  return assert.rejects(createSourceUploadIntent({ project, user: { _id: viewerId }, metadata: file }), /Only project owners and editors/);
});

test('Supabase deletion failures retain the source record and report the failure', async () => {
  const SourceModel = makeSourceModel();
  const source = await SourceModel.create({ storageProvider: 'supabase', storageBucket: 'relay-files', storageKey: 'project-1/delete.txt', uploadStatus: 'completed' });
  const storageConfig = makeStorage({ failRemove: true });
  await assert.rejects(deleteSupabaseSource(source, { storageConfig }), (error) => error.status === 502 && /record was retained/.test(error.message));
  assert.equal(SourceModel.records.has(String(source._id)), true);
  assert.equal(source.uploadStatus, 'completed');
});

test('successful Supabase deletion removes the object before the MongoDB source record', async () => {
  const SourceModel = makeSourceModel();
  const source = await SourceModel.create({ storageProvider: 'supabase', storageBucket: 'relay-files', storageKey: 'project-1/delete.txt', uploadStatus: 'completed' });
  const storageConfig = makeStorage();
  assert.equal(await deleteSupabaseSource(source, { storageConfig }), true);
  assert.equal(storageConfig.bucket.calls.remove[0][0], 'project-1/delete.txt');
  assert.equal(SourceModel.records.has(String(source._id)), false);
});

test('buffer extraction supports TXT and Markdown and rejects unsupported extensions', async () => {
  const bytes = Buffer.from('Relay source text');
  assert.equal(await extractTextFromBuffer(bytes, 'notes.txt'), 'Relay source text');
  assert.equal(await extractTextFromBuffer(bytes, 'notes.md'), 'Relay source text');
  await assert.rejects(extractTextFromBuffer(bytes, 'notes.rtf'), /Unsupported file type/);
});
