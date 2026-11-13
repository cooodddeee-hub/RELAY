import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { canEditProject, canReadProject } from './projectPermissions.js';
import { extractTextFromBuffer } from './documentText.js';
import { getSupabaseStorage } from './supabaseStorage.js';
import Source from '../models/Source.js';

export const MAX_SOURCE_SIZE = 15 * 1024 * 1024;
export const SIGNED_DOWNLOAD_TTL_SECONDS = 5 * 60;
export const UPLOAD_INTENT_TTL_MS = 2 * 60 * 60 * 1000;

const MIME_TYPES_BY_EXTENSION = {
  '.pdf': new Set(['application/pdf', 'application/x-pdf', 'application/octet-stream']),
  '.docx': new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/octet-stream']),
  '.txt': new Set(['text/plain', 'application/octet-stream']),
  '.md': new Set(['text/markdown', 'text/x-markdown', 'text/plain', 'application/octet-stream']),
};

export class SourceWorkflowError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'SourceWorkflowError';
    this.status = status;
  }
}

export function validateSourceUpload({ originalName, mimeType, size } = {}) {
  if (typeof originalName !== 'string' || !originalName.trim() || originalName.length > 255 || /[\u0000-\u001f\u007f]/.test(originalName)) {
    throw new SourceWorkflowError('Provide a valid source filename.');
  }
  const safeName = path.basename(originalName.trim().replace(/\\/g, '/'));
  const extension = path.extname(safeName).toLowerCase();
  if (!MIME_TYPES_BY_EXTENSION[extension]) {
    throw new SourceWorkflowError('Only PDF, DOCX, TXT and MD files are accepted.');
  }
  const normalizedMime = typeof mimeType === 'string' ? mimeType.split(';', 1)[0].trim().toLowerCase() : '';
  if (!MIME_TYPES_BY_EXTENSION[extension].has(normalizedMime)) {
    throw new SourceWorkflowError('The declared file type does not match the filename extension.');
  }
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_SOURCE_SIZE) {
    throw new SourceWorkflowError('Source files must be between 1 byte and 15 MiB.');
  }
  return { originalName: safeName, extension, mimeType: normalizedMime, size };
}

export function assertSourceReadAccess(project, userId) {
  if (!project || !canReadProject(project, userId)) throw new SourceWorkflowError('Access denied.', 403);
}

export function assertSourceEditAccess(project, userId) {
  if (!project || !canEditProject(project, userId)) throw new SourceWorkflowError('Only project owners and editors can manage sources.', 403);
}

function storageFailure(message, status = 502) {
  // Do not forward provider errors: they can contain signed URLs or provider details.
  return new SourceWorkflowError(message, status);
}

export async function createSourceUploadIntent({ project, user, metadata, SourceModel = Source, storageConfig, uuid = randomUUID, now = Date.now }) {
  assertSourceEditAccess(project, user?._id);
  const file = validateSourceUpload(metadata);
  const configured = storageConfig || getSupabaseStorage();
  const storage = configured.bucket;
  const bucketName = configured.bucketName;
  const storageKey = `${String(project._id)}/${uuid()}${file.extension}`;

  let signed;
  try { signed = await storage.createSignedUploadUrl(storageKey, { upsert: false }); }
  catch { throw storageFailure('Could not prepare a secure source upload.'); }
  if (signed?.error || typeof signed?.data?.signedUrl !== 'string') {
    throw storageFailure('Could not prepare a secure source upload.');
  }

  let source;
  try {
    source = await SourceModel.create({
      project: project._id,
      originalName: file.originalName,
      mimeType: file.mimeType,
      size: file.size,
      storageProvider: 'supabase',
      storageBucket: bucketName,
      storageKey,
      storagePath: undefined,
      uploadStatus: 'pending',
      uploadIntentExpiresAt: new Date(now() + UPLOAD_INTENT_TTL_MS),
      status: 'uploaded',
      extractedText: '',
      uploadedBy: user._id,
    });
  } catch {
    throw storageFailure('Could not save the source upload request.', 500);
  }

  // The signed URL is an intentionally short-lived bearer capability for this authorized upload.
  // It is returned only to this authenticated caller and must never be logged or persisted.
  return { source, uploadUrl: signed.data.signedUrl };
}

async function markCompletionFailed(source, errorMessage = 'Document processing failed.') {
  source.uploadStatus = 'failed';
  source.status = 'failed';
  source.error = errorMessage;
  await source.save().catch(() => {});
}

export async function completeSourceUpload({ source, project, userId, SourceModel = Source, storageConfig, extract = extractTextFromBuffer, now = Date.now }) {
  assertSourceEditAccess(project, userId);
  if (!source || source.storageProvider !== 'supabase' || !source.storageKey || !source.storageBucket) {
    throw new SourceWorkflowError('Source upload intent not found.', 404);
  }
  if (String(source.uploadedBy) !== String(userId)) throw new SourceWorkflowError('Only the user who started this upload can complete it.', 403);
  if (source.storageBucket !== (storageConfig?.bucketName || getSupabaseStorage().bucketName)) {
    throw new SourceWorkflowError('Source upload storage configuration does not match.', 409);
  }
  if (source.uploadStatus === 'completed') return { source, alreadyCompleted: true };
  if (source.uploadStatus === 'pending' && source.uploadIntentExpiresAt && new Date(source.uploadIntentExpiresAt).getTime() < now()) {
    throw new SourceWorkflowError('The upload authorization has expired. Start a new upload.', 410);
  }
  if (!['pending', 'failed'].includes(source.uploadStatus)) {
    throw new SourceWorkflowError('This source upload is already being processed.', 409);
  }

  const claimed = await SourceModel.findOneAndUpdate(
    { _id: source._id, storageProvider: 'supabase', uploadStatus: source.uploadStatus, uploadedBy: userId },
    { $set: { uploadStatus: 'processing', status: 'processing', error: '' } },
    { new: true },
  );
  if (!claimed) {
    const latest = await SourceModel.findById(source._id);
    if (latest?.uploadStatus === 'completed') return { source: latest, alreadyCompleted: true };
    throw new SourceWorkflowError('This source upload is already being processed.', 409);
  }

  const configured = storageConfig || getSupabaseStorage();
  const storage = configured.bucket;
  try {
    const infoResult = await storage.info(claimed.storageKey);
    const actualSize = infoResult?.data?.size;
    if (infoResult?.error || !Number.isSafeInteger(actualSize)) {
      throw storageFailure('Uploaded source could not be verified.', 400);
    }
    if (actualSize < 1 || actualSize > MAX_SOURCE_SIZE || actualSize !== claimed.size) {
      throw storageFailure('Uploaded source size does not match the authorized upload.', 400);
    }

    const downloaded = await storage.download(claimed.storageKey);
    if (downloaded?.error || !downloaded?.data || typeof downloaded.data.arrayBuffer !== 'function') {
      throw storageFailure('Uploaded source could not be read for processing.', 502);
    }
    const buffer = Buffer.from(await downloaded.data.arrayBuffer());
    if (buffer.length !== actualSize || buffer.length > MAX_SOURCE_SIZE) {
      throw storageFailure('Uploaded source size could not be verified.', 400);
    }

    claimed.extractedText = await extract(buffer, claimed.originalName);
    claimed.status = 'processed';
    claimed.uploadStatus = 'completed';
    claimed.error = '';
    claimed.uploadIntentExpiresAt = undefined;
    await claimed.save();
    return { source: claimed, alreadyCompleted: false };
  } catch (error) {
    const publicMessage = error instanceof SourceWorkflowError ? error.message : 'Document text extraction failed.';
    await markCompletionFailed(claimed, publicMessage);
    if (error instanceof SourceWorkflowError) throw error;
    throw storageFailure(publicMessage, 422);
  }
}

export async function createSourceDownloadUrl(source, { storageConfig, expiresIn = SIGNED_DOWNLOAD_TTL_SECONDS } = {}) {
  if (source.storageProvider !== 'supabase') return null;
  if (source.uploadStatus !== 'completed' || !source.storageKey || !source.storageBucket) {
    throw new SourceWorkflowError('The original source file is not ready for download.', 409);
  }
  const configured = storageConfig || getSupabaseStorage();
  if (source.storageBucket !== configured.bucketName) throw new SourceWorkflowError('Source storage configuration does not match.', 409);
  let result;
  try { result = await configured.bucket.createSignedUrl(source.storageKey, expiresIn, { download: source.originalName }); }
  catch { throw storageFailure('Could not prepare the source download.'); }
  if (result?.error || typeof result?.data?.signedUrl !== 'string') throw storageFailure('Could not prepare the source download.');
  return result.data.signedUrl;
}

export async function deleteSupabaseSource(source, { storageConfig } = {}) {
  if (source.storageProvider !== 'supabase') return false;
  if (!source.storageKey || !source.storageBucket) throw new SourceWorkflowError('Source storage metadata is incomplete.', 409);
  const configured = storageConfig || getSupabaseStorage();
  if (source.storageBucket !== configured.bucketName) throw new SourceWorkflowError('Source storage configuration does not match.', 409);

  const previousStatus = source.uploadStatus;
  if (previousStatus !== 'deleting') {
    source.uploadStatus = 'deleting';
    await source.save();
  }
  const result = await configured.bucket.remove([source.storageKey]);
  if (result?.error) {
    if (previousStatus !== 'deleting') {
      source.uploadStatus = previousStatus;
      await source.save().catch(() => {});
    }
    throw storageFailure('Could not delete the stored source file. The source record was retained.', 502);
  }
  // If this fails, the deleting state remains so a later authorized retry can finish cleanup.
  await source.deleteOne();
  return true;
}
