import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import AnalysisJob from '../models/AnalysisJob.js';
import AuditEvent from '../models/AuditEvent.js';
import ContradictionCandidate from '../models/ContradictionCandidate.js';
import Finding from '../models/Finding.js';
import GitHubInstallState from '../models/GitHubInstallState.js';
import GitHubSyncJob from '../models/GitHubSyncJob.js';
import Handover from '../models/Handover.js';
import HandoverSignoff from '../models/HandoverSignoff.js';
import Project from '../models/Project.js';
import ProjectAssignment from '../models/ProjectAssignment.js';
import ProjectDeletionJob from '../models/ProjectDeletionJob.js';
import ProjectRepository from '../models/ProjectRepository.js';
import ReviewHistory from '../models/ReviewHistory.js';
import Source from '../models/Source.js';
import SourceRevision from '../models/SourceRevision.js';
import { appendAuditEvent } from './auditEvents.js';
import { getSupabaseStorage } from './supabaseStorage.js';

export const PROJECT_DELETION_RECOVERY_MS = 30 * 24 * 60 * 60 * 1000;
export const PROJECT_DELETION_BATCH_SIZE = 20;
export const PROJECT_DELETION_LEASE_MS = 5 * 60 * 1000;
export const PROJECT_DELETION_POLICY_VERSION = 'round3-recovery-30d-v1';
const PHASE_MODELS = [
  ['source_revisions', SourceRevision], ['sources', Source], ['findings', Finding], ['review_history', ReviewHistory],
  ['contradictions', ContradictionCandidate], ['assignments', ProjectAssignment], ['handovers', Handover],
  ['repository_links', ProjectRepository], ['github_install_states', GitHubInstallState],
  ['analysis_jobs', AnalysisJob], ['github_sync_jobs', GitHubSyncJob],
];

async function withTransaction(work) {
  const session = await mongoose.startSession();
  try { return await session.withTransaction(() => work(session)); }
  finally { await session.endSession(); }
}

export async function requestProjectDeletion({ projectId, actorId, now = new Date() }) {
  await Promise.all([ProjectDeletionJob.init(), AuditEvent.init()]);
  return withTransaction(async (session) => {
    const project = await Project.findById(projectId).session(session);
    if (!project || String(project.owner) !== String(actorId)) {
      const error = new Error('Only the current project owner can request deletion.'); error.status = 403; throw error;
    }
    if ((project.deletionState || 'active') !== 'active') {
      const error = new Error('Project deletion is already requested or complete.'); error.status = 409; throw error;
    }
    project.deletionState = 'queued';
    project.deletionRequestedAt = now;
    project.deletedBy = actorId;
    await project.save({ session });
    let job = await ProjectDeletionJob.findOne({ projectId }).session(session);
    if (job) {
      if (job.phase !== 'cancelled' || job.status !== 'complete') {
        const error = new Error('A project deletion job already exists.'); error.status = 409; throw error;
      }
      job.status = 'queued';
      job.phase = 'source_files';
      job.cursor = undefined;
      job.attemptCount = 0;
      job.lastErrorCode = undefined;
      job.nextAttemptAt = undefined;
      job.leaseToken = undefined;
      job.leaseExpiresAt = undefined;
      await job.save({ session });
    } else {
      [job] = await ProjectDeletionJob.create([{
        projectId, requester: actorId, policyVersion: PROJECT_DELETION_POLICY_VERSION,
        status: 'queued', phase: 'source_files', attemptCount: 0,
      }], { session });
    }
    await appendAuditEvent({ projectId, actorId, action: 'project.deletion.requested', targetType: 'project', targetId: projectId, policyVersion: PROJECT_DELETION_POLICY_VERSION, comment: 'Project access frozen; deletion enters a 30-day recovery window.', session, now });
    return { project, job };
  });
}

export async function cancelProjectDeletion({ projectId, actorId, now = new Date() }) {
  await Promise.all([ProjectDeletionJob.init(), AuditEvent.init()]);
  return withTransaction(async (session) => {
    const project = await Project.findById(projectId).session(session);
    if (!project || String(project.owner) !== String(actorId)) {
      const error = new Error('Only the project owner can recover a project.'); error.status = 403; throw error;
    }
    const recoveryEndsAt = project.deletionRequestedAt ? new Date(project.deletionRequestedAt).getTime() + PROJECT_DELETION_RECOVERY_MS : 0;
    const job = await ProjectDeletionJob.findOne({ projectId }).session(session);
    if (project.deletionState !== 'queued' || !job || !['queued', 'retry_wait'].includes(job.status) || now.getTime() >= recoveryEndsAt) {
      const error = new Error('Project recovery is no longer available.'); error.status = 409; throw error;
    }
    project.deletionState = 'active';
    project.deletionRequestedAt = undefined;
    project.deletedAt = undefined;
    project.deletedBy = undefined;
    await project.save({ session });
    job.status = 'complete';
    job.phase = 'cancelled';
    job.lastErrorCode = undefined;
    job.nextAttemptAt = undefined;
    job.leaseToken = undefined;
    job.leaseExpiresAt = undefined;
    await job.save({ session });
    await appendAuditEvent({ projectId, actorId, action: 'project.deletion.cancelled', targetType: 'project', targetId: projectId, comment: 'Deletion cancelled during the recovery window.', session, now });
    return project;
  });
}

async function deleteProjectStorage(source) {
  if (source.storageProvider === 'supabase') {
    if (!source.storageKey || !source.storageBucket) throw Object.assign(new Error('Stored source metadata is incomplete.'), { code: 'STORAGE_METADATA_INCOMPLETE' });
    const configured = getSupabaseStorage();
    if (source.storageBucket !== configured.bucketName) throw Object.assign(new Error('Storage provider configuration does not match.'), { code: 'STORAGE_CONFIGURATION_MISMATCH' });
    const result = await configured.bucket.remove([source.storageKey]);
    if (result?.error) throw Object.assign(new Error('Stored source cleanup failed.'), { code: 'OBJECT_STORAGE_DELETE_FAILED' });
    return;
  }
  if (source.storagePath) {
    const uploadRoot = path.resolve(process.cwd(), 'uploads');
    const sourcePath = path.resolve(source.storagePath);
    const relative = path.relative(uploadRoot, sourcePath);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw Object.assign(new Error('Stored local path is outside the managed upload directory.'), { code: 'UNSAFE_STORAGE_PATH' });
    }
    try { await fs.unlink(sourcePath); }
    catch (error) { if (error?.code !== 'ENOENT') throw Object.assign(new Error('Local source cleanup failed.'), { code: 'LOCAL_FILE_DELETE_FAILED' }); }
  }
}

async function advanceCursor(job, cursor) {
  const saved = await ProjectDeletionJob.updateOne(
    { _id: job._id, status: 'running', leaseToken: job.leaseToken },
    { $set: { cursor: String(cursor), updatedAt: new Date() } },
  );
  if (saved.modifiedCount !== 1) throw Object.assign(new Error('Deletion processor lease expired.'), { code: 'DELETION_LEASE_LOST' });
}

async function processSourceFiles(job) {
  const query = { project: job.projectId, _id: job.cursor ? { $gt: job.cursor } : { $exists: true } };
  const sources = await Source.find(query).select('_id storageProvider storageBucket storageKey storagePath').sort({ _id: 1 }).limit(PROJECT_DELETION_BATCH_SIZE).lean();
  if (!sources.length) {
    await ProjectDeletionJob.updateOne({ _id: job._id, leaseToken: job.leaseToken }, { $set: { phase: PHASE_MODELS[0][0] }, $unset: { cursor: 1 } });
    return { phase: PHASE_MODELS[0][0], processed: 0 };
  }
  let processed = 0;
  for (const source of sources) {
    await deleteProjectStorage(source);
    await advanceCursor(job, source._id);
    processed += 1;
  }
  return { phase: 'source_files', processed };
}

async function processModelBatch(job) {
  const index = PHASE_MODELS.findIndex(([phase]) => phase === job.phase);
  if (index < 0) return null;
  const [phase, Model] = PHASE_MODELS[index];
  const query = { project: job.projectId, _id: job.cursor ? { $gt: job.cursor } : { $exists: true } };
  const rows = await Model.find(query).select('_id').sort({ _id: 1 }).limit(PROJECT_DELETION_BATCH_SIZE).lean();
  if (rows.length) {
    await Model.deleteMany({ _id: { $in: rows.map((row) => row._id) }, project: job.projectId });
    await advanceCursor(job, rows.at(-1)._id);
    return { phase, processed: rows.length };
  }
  const nextPhase = PHASE_MODELS[index + 1]?.[0] || 'finalize';
  await ProjectDeletionJob.updateOne({ _id: job._id, leaseToken: job.leaseToken }, { $set: { phase: nextPhase }, $unset: { cursor: 1 } });
  return { phase: nextPhase, processed: 0 };
}

async function finalizeProjectDeletion(job, now) {
  await withTransaction(async (session) => {
    const project = await Project.findOne({ _id: job.projectId, deletionState: 'purging' }).session(session);
    const currentJob = await ProjectDeletionJob.findOne({ _id: job._id, leaseToken: job.leaseToken, status: 'running' }).session(session);
    if (!project || !currentJob) throw Object.assign(new Error('Deletion job lost its project or lease.'), { code: 'DELETION_LEASE_LOST' });
    project.name = 'Deleted project';
    project.description = '';
    project.members = [];
    project.workflowPolicy = { reviewMode: 'legacy_editors', signoffMode: 'none' };
    project.deletionState = 'complete';
    project.deletedAt = now;
    await project.save({ session });
    await ProjectDeletionJob.deleteOne({ _id: currentJob._id, leaseToken: job.leaseToken, status: 'running' }).session(session);
    await appendAuditEvent({ projectId: project._id, actorId: job.requester, action: 'project.deletion.completed', targetType: 'project', targetId: project._id, policyVersion: job.policyVersion, comment: 'Project content purge completed; audit and sign-off metadata remain under configured retention.', session, now });
  });
}

export async function processProjectDeletionBatch({ now = new Date(), batchSize = PROJECT_DELETION_BATCH_SIZE } = {}) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > PROJECT_DELETION_BATCH_SIZE) throw new TypeError(`batchSize must be between 1 and ${PROJECT_DELETION_BATCH_SIZE}.`);
  const cutoff = new Date(now.getTime() - PROJECT_DELETION_RECOVERY_MS);
  const projects = await Project.find({ deletionState: { $in: ['queued', 'purging', 'blocked'] }, deletionRequestedAt: { $lte: cutoff } }).select('_id').limit(batchSize).lean();
  const results = [];
  for (const project of projects) {
    const token = randomUUID();
    const job = await ProjectDeletionJob.findOneAndUpdate(
      {
        projectId: project._id,
        $and: [
          { $or: [{ status: { $in: ['queued', 'retry_wait'] } }, { status: 'running', leaseExpiresAt: { $lte: now } }] },
          { $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: now } }] },
        ],
      },
      { $set: { status: 'running', leaseToken: token, leaseExpiresAt: new Date(now.getTime() + PROJECT_DELETION_LEASE_MS) }, $inc: { attemptCount: 1 } },
      { new: true, select: '+leaseToken +leaseExpiresAt' },
    );
    if (!job) continue;
    await Project.updateOne({ _id: project._id, deletionState: { $in: ['queued', 'purging', 'blocked'] } }, { $set: { deletionState: 'purging' } });
    try {
      if (job.phase === 'source_files') results.push({ projectId: String(project._id), ...(await processSourceFiles(job)) });
      else if (job.phase === 'finalize') {
        await finalizeProjectDeletion(job, now);
        results.push({ projectId: String(project._id), phase: 'complete', processed: 0 });
      } else {
        const result = await processModelBatch(job);
        if (!result) throw Object.assign(new Error('Deletion phase is unsupported.'), { code: 'DELETION_PHASE_INVALID' });
        results.push({ projectId: String(project._id), ...result });
      }
      await ProjectDeletionJob.updateOne({ _id: job._id, leaseToken: token, status: 'running' }, { $set: { status: 'queued', lastErrorCode: undefined }, $unset: { leaseToken: 1, leaseExpiresAt: 1, nextAttemptAt: 1 } });
    } catch (error) {
      const exponent = Math.min(10, Math.max(0, job.attemptCount - 1));
      const delay = Math.min(6 * 60 * 60 * 1000, 30_000 * (2 ** exponent));
      const code = /^[A-Z0-9_]{1,120}$/.test(error?.code || '') ? error.code : 'CLEANUP_FAILED';
      await ProjectDeletionJob.updateOne({ _id: job._id, leaseToken: token }, {
        $set: { status: 'retry_wait', lastErrorCode: code, nextAttemptAt: new Date(now.getTime() + delay) },
        $unset: { leaseToken: 1, leaseExpiresAt: 1 },
      });
      results.push({ projectId: String(project._id), phase: job.phase, status: 'retry_wait', errorCode: code });
    }
  }
  return { processedProjects: results.length, results };
}
