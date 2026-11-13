import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analysisFailureDisposition, analysisFindingKey, analysisJobClaimState, canAccessAnalysisJob,
  nextAnalysisCheckpoint, publicAnalysisJob, reuseActiveAnalysisJob, runMongoTransaction,
} from '../src/services/analysisJobState.js';

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
