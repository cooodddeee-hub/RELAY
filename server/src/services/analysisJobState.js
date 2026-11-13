import { createHash } from 'node:crypto';
import { canEditProject, canReadProject } from './projectPermissions.js';

export function analysisFindingKey(projectId, sourceId, title) {
  const normalized = String(title).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  return createHash('sha256').update(`${projectId}:${sourceId}:${normalized}`).digest('hex');
}

export function publicAnalysisJob(job, now = new Date()) {
  if (!job) return null;
  const value = typeof job.toObject === 'function' ? job.toObject() : { ...job };
  delete value.leaseToken;
  delete value.leaseExpiresAt;
  value.leaseActive = Boolean(job.leaseExpiresAt && new Date(job.leaseExpiresAt) > now);
  value.elapsedMs = job.startedAt ? Math.max(0, now.getTime() - new Date(job.startedAt).getTime()) : 0;
  return value;
}

export function analysisJobClaimState(job, now = new Date()) {
  if (['completed', 'failed'].includes(job.status)) return 'terminal';
  if (job.retryAt && new Date(job.retryAt) > now) return 'waiting_retry';
  if (job.leaseExpiresAt && new Date(job.leaseExpiresAt) > now) return 'leased';
  if ((job.nextSourceIndex || 0) >= (job.sourceIds?.length || 0)) return 'complete';
  return 'ready';
}

export function analysisFailureDisposition({ retryable, attemptCount, maxAttempts = 3 }) {
  const retry = Boolean(retryable) && attemptCount < maxAttempts;
  return { status: retry ? 'retry_wait' : 'failed', stage: retry ? 'retry_wait' : 'failed', retryable: Boolean(retryable) };
}

export function canAccessAnalysisJob(project, userId, action = 'read') {
  if (!canReadProject(project, userId)) return false;
  return action === 'read' || canEditProject(project, userId);
}

export async function reuseActiveAnalysisJob(project, loadJob, clearMissing) {
  if (!project?.activeAnalysisJob) return null;
  const job = await loadJob(project.activeAnalysisJob);
  if (job) return job;
  await clearMissing(project.activeAnalysisJob);
  return null;
}

export function nextAnalysisCheckpoint(job) {
  const nextSourceIndex = job.nextSourceIndex + 1;
  const completedSourceCount = Math.min(job.sourceIds.length, job.completedSourceCount + 1);
  const done = nextSourceIndex >= job.sourceIds.length;
  return {
    nextSourceIndex,
    completedSourceCount,
    status: done ? 'completed' : 'queued',
    stage: done ? 'completed' : 'queued',
    done,
  };
}

export async function runMongoTransaction(work, startSession) {
  const session = await startSession();
  try { return await session.withTransaction(() => work(session)); }
  finally { await session.endSession(); }
}
