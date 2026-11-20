import { createHash } from 'node:crypto';
import { canEditProject, canReadProject } from './projectPermissions.js';

export function analysisFindingKey(projectId, sourceId, title, revisionIdentity) {
  const normalized = String(title).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  const revision = revisionIdentity ? `:${revisionIdentity}` : '';
  return createHash('sha256').update(`${projectId}:${sourceId}${revision}:${normalized}`).digest('hex');
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
  if (!job || job.status !== 'failed' || !['cloudflare_provider', 'cloudflare_timeout', 'gemini_provider', 'gemini_timeout'].includes(job.lastErrorKind)) return false;
  const attempts = job.lastProviderAttempts || [];
  if (attempts.length < 2) return false;
  const providerOrder = [];
  for (const attempt of attempts) {
    if (attempt?.outcome !== 'temporary_failure') return false;
    if (attempt.category !== undefined) {
      if (!['timeout', 'http', 'network'].includes(attempt.category)) return false;
      if (attempt.category === 'http' && ![408, 429, 500, 502, 503, 504].includes(attempt.status)) return false;
    }
    if (providerOrder.at(-1) !== attempt.provider) providerOrder.push(attempt.provider);
  }
  if (providerOrder.length !== 2 || !providerOrder.includes('cloudflare') || !providerOrder.includes('gemini')) return false;
  const primary = providerOrder[0];
  const secondary = providerOrder[1];
  return attempts.every((attempt) => attempt.role === undefined
    || attempt.role === (attempt.provider === primary ? 'primary' : attempt.provider === secondary ? 'secondary' : null));
}

export function safeProviderAttempts(attempts) {
  const providers = ['gemini', 'cloudflare'];
  const roles = ['primary', 'secondary'];
  const outcomes = ['success', 'temporary_failure', 'permanent_failure', 'invalid_output', 'configuration_failure'];
  const categories = ['success', 'timeout', 'http', 'network', 'configuration', 'invalid_output', 'unknown'];
  const errorCodes = ['none', 'timeout', 'http_error', 'network_error', 'connection_error', 'configuration_error', 'invalid_output', 'unknown'];
  if (!Array.isArray(attempts)) return [];
  return attempts.slice(0, 8).flatMap((attempt) => {
    if (!providers.includes(attempt?.provider) || !outcomes.includes(attempt?.outcome)) return [];
    const safe = { provider: attempt.provider, outcome: attempt.outcome };
    if (roles.includes(attempt.role)) safe.role = attempt.role;
    if (Number.isInteger(attempt.status) && attempt.status >= 100 && attempt.status <= 599) safe.status = attempt.status;
    if (categories.includes(attempt.category)) safe.category = attempt.category;
    if (errorCodes.includes(attempt.errorCode)) safe.errorCode = attempt.errorCode;
    return [safe];
  });
}

const validationFailureCodes = new Set([
  'invalid_json', 'invalid_response_envelope', 'missing_findings_array', 'invalid_finding_schema',
  'missing_evidence', 'evidence_quote_mismatch', 'unsupported_evidence_reference', 'incomplete_provider_response',
]);
const validationStages = new Set(['provider_envelope', 'model_json', 'findings_array', 'finding_schema', 'evidence_reference', 'evidence_verification']);

export function safeValidationDiagnostic(value) {
  if (!value || !['gemini', 'cloudflare'].includes(value.provider)
    || !validationFailureCodes.has(value.failureCode) || !validationStages.has(value.validationStage)) return undefined;
  const sourceType = ['upload', 'readme', 'commit', 'issue', 'github_other'].includes(value.sourceType) ? value.sourceType : undefined;
  const sourceId = /^[a-f\d]{24}$/i.test(String(value.sourceId || '')) ? String(value.sourceId) : undefined;
  const sourcePosition = Number.isInteger(value.sourcePosition) && value.sourcePosition > 0 && value.sourcePosition <= 500
    ? value.sourcePosition : undefined;
  return {
    provider: value.provider,
    validationStage: value.validationStage,
    failureCode: value.failureCode,
    ...(sourceType ? { sourceType } : {}),
    ...(sourceId ? { sourceId } : {}),
    ...(sourcePosition ? { sourcePosition } : {}),
    ...(value.quoteMatchDiagnostics
      && ['exactQuoteMatch', 'caseOnlyMatch', 'punctuationOnlyMatch', 'unicodeNormalizationMatch']
        .every((key) => typeof value.quoteMatchDiagnostics[key] === 'boolean')
      ? { quoteMatchDiagnostics: {
        exactQuoteMatch: value.quoteMatchDiagnostics.exactQuoteMatch,
        caseOnlyMatch: value.quoteMatchDiagnostics.caseOnlyMatch,
        punctuationOnlyMatch: value.quoteMatchDiagnostics.punctuationOnlyMatch,
        unicodeNormalizationMatch: value.quoteMatchDiagnostics.unicodeNormalizationMatch,
      } } : {}),
  };
}

export function analysisRetryUpdate(job, now = new Date()) {
  return {
    $set: {
      status: 'queued', stage: 'queued', attemptCount: 0, retryable: false,
      lastProgressAt: now, currentSource: job.sourceIds[job.nextSourceIndex],
    },
    $unset: {
      retryAt: 1, lastErrorKind: 1, lastErrorStatus: 1, lastProviderAttempts: 1,
      lastValidationFailure: 1,
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
  if (error?.code === 'ANALYSIS_REVISION_UNAVAILABLE') return 'revision_unavailable';
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
