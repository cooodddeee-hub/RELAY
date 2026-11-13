import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analysisFailureCode, analysisFailureDisposition, analysisFindingKey, analysisJobClaimState, canAccessAnalysisJob,
  analysisRetryUpdate, isEligibleDemoFallback, nextAnalysisCheckpoint, publicAnalysisJob, reuseActiveAnalysisJob, runMongoTransaction, safeProviderAttempts,
} from '../src/services/analysisJobState.js';
import { DEMO_ANALYSIS_FALLBACK } from '../../client/src/data/demoAnalysisFallback.js';

test('job creation reuses an active job rather than creating a duplicate', async () => {
  const existing = { _id: 'persisted-job', status: 'queued' };
  let createCalls = 0;
  const result = await reuseActiveAnalysisJob(
    { activeAnalysisJob: existing._id },
    async () => existing,
    async () => {},
  );
  if (!result) createCalls += 1;
  assert.equal(result, existing);
  assert.equal(createCalls, 0);
});

test('atomic lease state prevents concurrent advancement and becomes claimable after expiry', () => {
  const now = new Date('2026-11-13T00:00:00Z');
  const job = { status: 'running', sourceIds: ['source-a'], nextSourceIndex: 0, leaseExpiresAt: new Date(now.getTime() + 60_000) };
  assert.equal(analysisJobClaimState(job, now), 'leased');
  assert.equal(analysisJobClaimState({ ...job, leaseExpiresAt: new Date(now.getTime() - 1) }, now), 'ready');
});

test('partial progress checkpoints only one source and leaves failed work at the same cursor', () => {
  const job = { sourceIds: ['a', 'b', 'c'], nextSourceIndex: 1, completedSourceCount: 1 };
  const beforeFailedRetry = { ...job };
  assert.deepEqual(nextAnalysisCheckpoint(job), { nextSourceIndex: 2, completedSourceCount: 2, status: 'queued', stage: 'queued', done: false });
  assert.equal(beforeFailedRetry.nextSourceIndex, 1);
  assert.equal(beforeFailedRetry.completedSourceCount, 1);
});

test('temporary provider failures enter bounded retry state; permanent failures stop', () => {
  assert.deepEqual(analysisFailureDisposition({ retryable: true, attemptCount: 1 }), { status: 'retry_wait', stage: 'retry_wait', retryable: true });
  assert.deepEqual(analysisFailureDisposition({ retryable: true, attemptCount: 3 }), { status: 'failed', stage: 'failed', retryable: true });
  assert.deepEqual(analysisFailureDisposition({ retryable: false, attemptCount: 1 }), { status: 'failed', stage: 'failed', retryable: false });
});

test('analysis failures persist only safe provider and failure categories', () => {
  assert.equal(analysisFailureCode({ provider: 'gemini', kind: 'timeout', message: 'private document text' }), 'gemini_timeout');
  assert.equal(analysisFailureCode({ provider: 'cloudflare', kind: 'invalid_response', message: 'private provider payload' }), 'cloudflare_invalid_response');
  assert.equal(analysisFailureCode({ code: 'ANALYSIS_STEP_BUDGET', message: 'private source text' }), 'step_budget_exceeded');
  assert.equal(analysisFailureCode(new Error('private details')), 'analysis_error');
});

test('demo fallback is exposed only after terminal Gemini and Cloudflare temporary failures', () => {
  const job = {
    status: 'failed', lastErrorKind: 'cloudflare_timeout',
    lastProviderAttempts: [
      { provider: 'gemini', outcome: 'temporary_failure' },
      { provider: 'cloudflare', outcome: 'temporary_failure' },
    ],
  };
  assert.equal(isEligibleDemoFallback(job), true);
  assert.equal(publicAnalysisJob(job).demoFallbackAvailable, true);
});

test('demo fallback accepts legacy and current provider order but rejects success or mixed sequences', () => {
  const valid = [
    { provider: 'cloudflare', outcome: 'temporary_failure', status: 503, category: 'http', errorCode: 'http_error', role: 'primary' },
    { provider: 'cloudflare', outcome: 'temporary_failure', status: 503, category: 'http', errorCode: 'http_error', role: 'primary' },
    { provider: 'gemini', outcome: 'temporary_failure', status: 504, category: 'timeout', errorCode: 'timeout', role: 'secondary' },
  ];
  assert.equal(isEligibleDemoFallback({ status: 'failed', lastErrorKind: 'gemini_timeout', lastProviderAttempts: valid }), true);
  assert.equal(isEligibleDemoFallback({ status: 'failed', lastErrorKind: 'gemini_timeout', lastProviderAttempts: [...valid, { provider: 'gemini', outcome: 'success' }] }), false);
  assert.equal(isEligibleDemoFallback({ status: 'failed', lastErrorKind: 'gemini_timeout', lastProviderAttempts: [valid[2], valid[0]] }), false);
  const legacyOrder = [
    { provider: 'gemini', outcome: 'temporary_failure' },
    { provider: 'cloudflare', outcome: 'temporary_failure' },
  ];
  assert.equal(isEligibleDemoFallback({ status: 'failed', lastErrorKind: 'cloudflare_timeout', lastProviderAttempts: legacyOrder }), true);
});

test('provider attempt metadata is sanitized and survives the public job status projection', () => {
  const attempts = safeProviderAttempts([
    { provider: 'gemini', outcome: 'temporary_failure', status: 503, category: 'http', errorCode: 'http_error', message: 'private prompt content' },
    { provider: 'cloudflare', outcome: 'success', category: 'success', errorCode: 'none', token: 'must-not-persist' },
  ]);
  assert.deepEqual(attempts, [
    { provider: 'gemini', outcome: 'temporary_failure', status: 503, category: 'http', errorCode: 'http_error' },
    { provider: 'cloudflare', outcome: 'success', category: 'success', errorCode: 'none' },
  ]);
  const publicJob = publicAnalysisJob({ _id: 'job-safe', status: 'completed', lastProviderAttempts: attempts });
  assert.deepEqual(publicJob.lastProviderAttempts, attempts);
  assert.equal(JSON.stringify(publicJob).includes('private prompt content'), false);
  assert.equal(JSON.stringify(publicJob).includes('must-not-persist'), false);
});

test('demo fallback is unavailable for invalid output, permanent/provider configuration errors, or incomplete provider sequences', () => {
  const providers = [
    { status: 'failed', lastErrorKind: 'cloudflare_invalid_response', lastProviderAttempts: [{ provider: 'gemini', outcome: 'temporary_failure' }, { provider: 'cloudflare', outcome: 'invalid_output' }] },
    { status: 'failed', lastErrorKind: 'cloudflare_configuration', lastProviderAttempts: [{ provider: 'gemini', outcome: 'temporary_failure' }, { provider: 'cloudflare', outcome: 'configuration_failure' }] },
    { status: 'failed', lastErrorKind: 'gemini_timeout', lastProviderAttempts: [{ provider: 'gemini', outcome: 'temporary_failure' }] },
    { status: 'retry_wait', lastErrorKind: 'cloudflare_timeout', lastProviderAttempts: [{ provider: 'gemini', outcome: 'temporary_failure' }, { provider: 'cloudflare', outcome: 'temporary_failure' }] },
  ];
  for (const job of providers) assert.equal(isEligibleDemoFallback(job), false);
});

test('retry reset hides demo fallback and repeated status rendering does not insert or mutate findings', () => {
  const retried = { status: 'queued', lastErrorKind: undefined, lastProviderAttempts: undefined };
  assert.equal(isEligibleDemoFallback(retried), false);
  const before = structuredClone(retried);
  for (let index = 0; index < 5; index += 1) assert.equal(isEligibleDemoFallback(retried), false);
  assert.deepEqual(retried, before);
});

test('the persisted retry update clears provider eligibility metadata and resumes the same source', () => {
  const job = { sourceIds: ['source-a', 'source-b'], nextSourceIndex: 1 };
  const update = analysisRetryUpdate(job, new Date('2026-11-13T00:00:00Z'));
  assert.equal(update.$set.status, 'queued');
  assert.equal(update.$set.currentSource, 'source-b');
  assert.equal(update.$unset.lastProviderAttempts, 1);
  assert.equal(update.$unset.lastErrorKind, 1);
});

test('demo fixture quotes exactly match its designated sample document and stay outside approved finding shape', () => {
  const { sourceText, findings } = DEMO_ANALYSIS_FALLBACK;
  assert.ok(findings.length > 0);
  for (const finding of findings) {
    assert.ok(sourceText.includes(finding.quote), `${finding.title} quote must be present verbatim in sample source`);
    assert.equal(Object.hasOwn(finding, '_id'), false);
    assert.equal(Object.hasOwn(finding, 'status'), false);
  }
  assert.equal(DEMO_ANALYSIS_FALLBACK.label, 'DEMO DATA — NOT LIVE AI OUTPUT');
});

test('persisted job state can be recovered after refresh without exposing its lease token', () => {
  const now = new Date('2026-11-13T00:00:00Z');
  const state = publicAnalysisJob({
    _id: 'job-1', project: 'project-1', status: 'running', stage: 'analyzing_source', sourceIds: ['source-a'],
    nextSourceIndex: 0, completedSourceCount: 0, leaseToken: 'private-lease', leaseExpiresAt: new Date(now.getTime() + 60_000), startedAt: now,
  }, now);
  assert.equal(state.stage, 'analyzing_source');
  assert.equal(state.completedSourceCount, 0);
  assert.equal(state.leaseActive, true);
  assert.equal('leaseToken' in state, false);
});

test('Mongo transaction wrapper always closes session and propagates rollback failure', async () => {
  let value = 0;
  let ended = false;
  const session = {
    async withTransaction(work) {
      const before = value;
      try { await work(); } catch (error) { value = before; throw error; }
    },
    async endSession() { ended = true; },
  };
  await assert.rejects(runMongoTransaction(async () => { value = 1; throw new Error('abort'); }, async () => session), /abort/);
  assert.equal(value, 0);
  assert.equal(ended, true);
});

test('finding deduplication keys include source and normalize equivalent titles', () => {
  assert.equal(analysisFindingKey('project', 'source-a', ' API  Decision '), analysisFindingKey('project', 'source-a', 'api decision'));
  assert.notEqual(analysisFindingKey('project', 'source-a', 'API Decision'), analysisFindingKey('project', 'source-b', 'API Decision'));
});

test('analysis job read and mutation authorization follows project roles', () => {
  const project = { owner: 'owner', members: [{ user: 'editor', role: 'editor' }, { user: 'viewer', role: 'viewer' }] };
  for (const action of ['read', 'advance']) assert.equal(canAccessAnalysisJob(project, 'owner', action), true);
  assert.equal(canAccessAnalysisJob(project, 'editor', 'read'), true);
  assert.equal(canAccessAnalysisJob(project, 'editor', 'advance'), true);
  assert.equal(canAccessAnalysisJob(project, 'viewer', 'read'), true);
  assert.equal(canAccessAnalysisJob(project, 'viewer', 'advance'), false);
  assert.equal(canAccessAnalysisJob(project, 'outsider', 'read'), false);
  assert.equal(canAccessAnalysisJob(project, 'outsider', 'advance'), false);
});
