import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import AnalysisJob from '../models/AnalysisJob.js';
import Finding from '../models/Finding.js';
import Project from '../models/Project.js';
import Source from '../models/Source.js';
import { extractFindings, GeminiAnalysisError } from './gemini.js';
import { analysisFailureCode, analysisFailureDisposition, analysisFindingKey, analysisJobClaimState, analysisRetryUpdate, nextAnalysisCheckpoint, publicAnalysisJob, reuseActiveAnalysisJob, runMongoTransaction, safeProviderAttempts } from './analysisJobState.js';

export const ANALYSIS_STEP_BUDGET_MS = 240_000;
export const ANALYSIS_LEASE_MS = 330_000;
const MAX_JOB_ATTEMPTS_PER_SOURCE = 3;

export class AnalysisJobError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'AnalysisJobError'; this.status = status; }
}

async function withTransaction(work) {
  return runMongoTransaction(work, () => mongoose.startSession());
}

export async function getProjectAnalysisJob(projectId) {
  const project = await Project.findById(projectId).select('+activeAnalysisJob').lean();
  if (!project?.activeAnalysisJob) return null;
  const job = await AnalysisJob.findById(project.activeAnalysisJob).select('+leaseExpiresAt');
  if (!job) {
    await Project.updateOne({ _id: projectId, activeAnalysisJob: project.activeAnalysisJob }, { $unset: { activeAnalysisJob: 1 } });
    return null;
  }
  return job;
}

export async function getAnalysisJob(jobId) { return AnalysisJob.findById(jobId).select('+leaseExpiresAt'); }

export async function createOrGetAnalysisJob({ projectId, actorId }) {
  const jobId = new mongoose.Types.ObjectId();
  let result = null;
  try {
    await withTransaction(async (session) => {
      const project = await Project.findById(projectId).select('+activeAnalysisJob').session(session);
      if (!project) throw new AnalysisJobError('Project not found.', 404);
      const active = await reuseActiveAnalysisJob(
        project,
        (id) => AnalysisJob.findById(id).select('+leaseExpiresAt').session(session),
        async () => { project.activeAnalysisJob = undefined; await project.save({ session }); },
      );
      if (active) { result = active; return; }

      const sources = await Source.find({ project: projectId, status: 'processed' })
        .select('+analysisCompletedAt').sort({ createdAt: 1, _id: 1 }).session(session);
      const pending = sources.filter((source) => !source.analysisCompletedAt);
      if (!pending.length) { result = null; return; }

      const job = new AnalysisJob({
        _id: jobId,
        project: projectId,
        createdBy: actorId,
        sourceIds: pending.map((source) => source._id),
        nextSourceIndex: 0,
        completedSourceCount: 0,
        status: 'queued',
        stage: 'queued',
        lastProgressAt: new Date(),
      });
      await job.save({ session });
      const claimed = await Project.updateOne(
        { _id: projectId, $or: [{ activeAnalysisJob: { $exists: false } }, { activeAnalysisJob: null }] },
        { $set: { activeAnalysisJob: job._id } },
        { session },
      );
      if (claimed.modifiedCount !== 1) throw new AnalysisJobError('An analysis job was started at the same time. Reload its status.', 409);
      result = job;
    });
  } catch (error) {
    if (!(error instanceof AnalysisJobError) || error.status !== 409) throw error;
    result = await getProjectAnalysisJob(projectId);
    if (!result) throw error;
  }
  return result;
}

async function claimStep(jobId, now) {
  const snapshot = await AnalysisJob.findById(jobId).select('+leaseExpiresAt');
  if (!snapshot) throw new AnalysisJobError('Analysis job not found.', 404);
  const state = analysisJobClaimState(snapshot, now);
  if (state === 'terminal' || state === 'waiting_retry') return { job: snapshot, claimed: false };
  if (state === 'leased') {
    throw new AnalysisJobError('This analysis step is already running. Its saved status will refresh shortly.', 409);
  }

  const token = randomUUID();
  const sourceId = snapshot.sourceIds[snapshot.nextSourceIndex];
  if (state === 'complete' || !sourceId) return { job: snapshot, claimed: false };
  const job = await AnalysisJob.findOneAndUpdate(
    {
      _id: jobId,
      nextSourceIndex: snapshot.nextSourceIndex,
      status: { $in: ['queued', 'running', 'retry_wait'] },
      $and: [
        { $or: [{ leaseExpiresAt: { $exists: false } }, { leaseExpiresAt: { $lte: now } }] },
        { $or: [{ retryAt: { $exists: false } }, { retryAt: { $lte: now } }] },
      ],
    },
    { $set: { status: 'running', stage: 'analyzing_source', currentSource: sourceId, leaseToken: token, leaseExpiresAt: new Date(now.getTime() + ANALYSIS_LEASE_MS), startedAt: snapshot.startedAt || now, lastProgressAt: now }, $inc: { attemptCount: 1 } },
    { new: true },
  ).select('+leaseToken +leaseExpiresAt');
  if (!job) throw new AnalysisJobError('Analysis status changed. Refresh and continue from the saved job.', 409);
  return { job, claimed: true, token, sourceId };
}

async function completeEmptyJob(job) {
  return withTransaction(async (session) => {
    const current = await AnalysisJob.findOne({ _id: job._id, nextSourceIndex: job.nextSourceIndex }).session(session);
    if (!current) throw new AnalysisJobError('Analysis job changed while completing.', 409);
    current.status = 'completed'; current.stage = 'completed'; current.completedAt = new Date(); current.currentSource = null;
    await current.save({ session });
    await Project.updateOne({ _id: current.project, activeAnalysisJob: current._id }, { $unset: { activeAnalysisJob: 1 } }, { session });
    return current;
  });
}

async function commitSourceStep({ jobId, token, sourceId, findings }) {
  return withTransaction(async (session) => {
    const job = await AnalysisJob.findOne({ _id: jobId, leaseToken: token }).select('+leaseToken').session(session);
    if (!job) throw new AnalysisJobError('Analysis step lease expired before its checkpoint.', 409);
    const source = await Source.findOne({ _id: sourceId, project: job.project }).select('+analysisCompletedAt').session(session);
    if (!source) throw new AnalysisJobError('The source for this analysis step no longer exists.', 404);

    if (!source.analysisCompletedAt) {
      for (const item of findings) {
        const key = analysisFindingKey(job.project, source._id, item.title);
        const legacy = await Finding.findOne({ project: job.project, 'evidence.source': source._id, title: item.title }).session(session);
        if (legacy) {
          if (!legacy.analysisKey) {
            const existingKey = await Finding.findOne({ analysisKey: key }).select('_id').session(session);
            if (!existingKey) { legacy.analysisKey = key; await legacy.save({ session }); }
          }
          continue;
        }
        await Finding.findOneAndUpdate(
          { analysisKey: key },
          { $setOnInsert: { project: job.project, analysisKey: key, ...item, status: 'pending' } },
          { upsert: true, new: true, setDefaultsOnInsert: true, session },
        );
      }
      source.analysisCompletedAt = new Date();
      await source.save({ session });
    }

    const checkpoint = nextAnalysisCheckpoint(job);
    const completedAt = checkpoint.done ? new Date() : undefined;
    const checkpointResult = await AnalysisJob.updateOne(
      { _id: job._id, leaseToken: token },
      {
        $set: {
          nextSourceIndex: checkpoint.nextSourceIndex,
          completedSourceCount: checkpoint.completedSourceCount,
          attemptCount: 0,
          currentSource: null,
          status: checkpoint.status,
          stage: checkpoint.stage,
          retryable: false,
          lastProgressAt: new Date(),
          ...(completedAt ? { completedAt } : {}),
        },
        $unset: { retryAt: 1, lastErrorKind: 1, lastErrorStatus: 1, lastProviderAttempts: 1, leaseToken: 1, leaseExpiresAt: 1 },
      },
      { session },
    );
    if (checkpointResult.modifiedCount !== 1) throw new AnalysisJobError('Analysis step lease expired before its checkpoint.', 409);
    if (checkpoint.done) {
      await Project.updateOne({ _id: job.project, activeAnalysisJob: job._id }, { $unset: { activeAnalysisJob: 1 } }, { session });
    }
    return AnalysisJob.findById(job._id).select('+leaseExpiresAt').session(session);
  });
}

function isTemporaryAnalysisFailure(error) {
  if (error?.hasErrorLabel?.('TransientTransactionError') || error?.hasErrorLabel?.('UnknownTransactionCommitResult')) return true;
  if (!(error instanceof GeminiAnalysisError) || !['provider', 'timeout'].includes(error.kind)) return false;
  if ([401, 403].includes(error.providerStatus)) return false;
  return error.retryable === true || [408, 429, 500, 502, 503, 504].includes(error.providerStatus);
}

async function recordStepFailure(job, token, error, now = new Date()) {
  const retryable = isTemporaryAnalysisFailure(error) || error?.code === 'ANALYSIS_STEP_BUDGET';
  const disposition = analysisFailureDisposition({ retryable, attemptCount: job.attemptCount, maxAttempts: MAX_JOB_ATTEMPTS_PER_SOURCE });
  const shouldRetry = disposition.status === 'retry_wait';
  const backoffMs = Math.min(30_000, 2_000 * (2 ** Math.max(0, job.attemptCount - 1)));
  const update = {
    $set: {
      status: disposition.status,
      stage: disposition.stage,
      retryable: disposition.retryable,
      ...(shouldRetry ? { retryAt: new Date(now.getTime() + backoffMs) } : {}),
      lastErrorKind: analysisFailureCode(error),
      ...(Number.isInteger(error?.status) ? { lastErrorStatus: error.status } : {}),
      lastProviderAttempts: safeProviderAttempts(error?.providerAttempts),
      currentSource: job.sourceIds[job.nextSourceIndex],
      lastProgressAt: now,
    },
    $unset: { leaseToken: 1, leaseExpiresAt: 1 },
  };
  if (!Number.isInteger(error?.status)) update.$unset.lastErrorStatus = 1;
  if (!shouldRetry) update.$unset.retryAt = 1;
  const saved = await AnalysisJob.findOneAndUpdate({ _id: job._id, leaseToken: token }, update, { new: true }).select('+leaseExpiresAt');
  return saved || AnalysisJob.findById(job._id);
}

export async function advanceAnalysisJob(jobId, { now = () => new Date(), analyze = extractFindings } = {}) {
  const startedAt = Date.now();
  const claim = await claimStep(jobId, now());
  if (!claim.claimed) {
    if (!claim.job.sourceIds?.length || claim.job.nextSourceIndex >= claim.job.sourceIds.length) return completeEmptyJob(claim.job);
    return claim.job;
  }
  const { job, token, sourceId } = claim;
  try {
    const source = await Source.findOne({ _id: sourceId, project: job.project, status: 'processed' });
    if (!source) throw new AnalysisJobError('The source for this analysis step is unavailable.', 404);
    const findings = await analyze(source);
    if (Date.now() - startedAt >= ANALYSIS_STEP_BUDGET_MS) {
      const budgetError = new Error('Analysis step exceeded its safe processing budget.');
      budgetError.code = 'ANALYSIS_STEP_BUDGET';
      return recordStepFailure(job, token, budgetError, now());
    }
    await AnalysisJob.updateOne({ _id: job._id, leaseToken: token }, { $set: { stage: 'saving_findings', lastProgressAt: now() } });
    return await commitSourceStep({ jobId, token, sourceId, findings });
  } catch (error) {
    if (error instanceof AnalysisJobError && error.status === 409) throw error;
    return recordStepFailure(job, token, error, now());
  }
}

export async function retryAnalysisJob(jobId) {
  const job = await AnalysisJob.findById(jobId);
  if (!job) throw new AnalysisJobError('Analysis job not found.', 404);
  if (job.status !== 'failed') throw new AnalysisJobError('Only a failed analysis job can be retried.', 409);
  if (job.nextSourceIndex >= job.sourceIds.length) throw new AnalysisJobError('There is no incomplete source to retry.', 409);
  return AnalysisJob.findOneAndUpdate(
    { _id: jobId, status: 'failed', $or: [{ leaseExpiresAt: { $exists: false } }, { leaseExpiresAt: null }, { leaseExpiresAt: { $lte: new Date() } }] },
    analysisRetryUpdate(job),
    { new: true },
  );
}

export async function detachCompletedJob(job) {
  if (job?.status === 'completed') await Project.updateOne({ _id: job.project, activeAnalysisJob: job._id }, { $unset: { activeAnalysisJob: 1 } });
}
