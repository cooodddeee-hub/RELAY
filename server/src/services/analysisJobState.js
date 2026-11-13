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
  value.demoFallbackAvailable = isEligibleDemoFallback(job);
  return value;
}

export function isEligibleDemoFallback(job) {
  if (!job || job.status !== 'failed' || !['cloudflare_provider', 'cloudflare_timeout'].includes(job.lastErrorKind)) return false;
  const attempts = job.lastProviderAttempts || [];
  if (attempts.length < 2) return false;
  let sawCloudflare = false;
  let sawGemini = false;
  for (const attempt of attempts) {
    if (attempt?.outcome !== 'temporary_failure') return false;
    if (attempt.category !== undefined) {
      if (!['timeout', 'http', 'network'].includes(attempt.category)) return false;
      if (attempt.category === 'http' && ![408, 429, 500, 502, 503, 504].includes(attempt.status)) return false;
    }
    if (attempt.provider === 'gemini' && !sawCloudflare) sawGemini = true;
    else if (attempt.provider === 'cloudflare') sawCloudflare = true;
    else return false;
  }
  return sawGemini && sawCloudflare;
}

export function safeProviderAttempts(attempts) {
  const providers = ['gemini', 'cloudflare'];
  const outcomes = ['success', 'temporary_failure', 'permanent_failure', 'invalid_output', 'configuration_failure'];
  const categories = ['success', 'timeout', 'http', 'network', 'configuration', 'invalid_output', 'unknown'];
  const errorCodes = ['none', 'timeout', 'http_error', 'network_error', 'connection_error', 'configuration_error', 'invalid_output', 'unknown'];
  if (!Array.isArray(attempts)) return [];
  return attempts.slice(0, 8).flatMap((attempt) => {
    if (!providers.includes(attempt?.provider) || !outcomes.includes(attempt?.outcome)) return [];
    const safe = { provider: attempt.provider, outcome: attempt.outcome };
    if (Number.isInteger(attempt.status) && attempt.status >= 100 && attempt.status <= 599) safe.status = attempt.status;
    if (categories.includes(attempt.category)) safe.category = attempt.category;
    if (errorCodes.includes(attempt.errorCode)) safe.errorCode = attempt.errorCode;
    return [safe];
  });
}

export function analysisRetryUpdate(job, now = new Date()) {
  return {
    $set: {
      status: 'queued', stage: 'queued', attemptCount: 0, retryable: false,
      lastProgressAt: now, currentSource: job.sourceIds[job.nextSourceIndex],
    },
    $unset: {
      retryAt: 1, lastErrorKind: 1, lastErrorStatus: 1, lastProviderAttempts: 1,
      leaseToken: 1, leaseExpiresAt: 1,
    },
  };
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

export function analysisFailureCode(error) {
  if (error?.code === 'ANALYSIS_STEP_BUDGET') return 'step_budget_exceeded';
  if (error?.name === 'AnalysisJobError' && error.status === 404) return 'source_unavailable';
  const provider = ['gemini', 'cloudflare'].includes(error?.provider) ? error.provider : null;
  const kind = ['timeout', 'invalid_response', 'configuration', 'provider'].includes(error?.kind) ? error.kind : null;
  return provider && kind ? `${provider}_${kind}` : 'analysis_error';
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
