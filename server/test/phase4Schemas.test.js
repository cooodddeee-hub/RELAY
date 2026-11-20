import test from 'node:test';
import assert from 'node:assert/strict';
import AnalysisJob from '../src/models/AnalysisJob.js';
import Finding from '../src/models/Finding.js';
import GitHubSyncJob, { GITHUB_SYNC_DEADLINE_MS, GITHUB_SYNC_LEASE_GRACE_MS } from '../src/models/GitHubSyncJob.js';
import Source from '../src/models/Source.js';
import SourceRevision from '../src/models/SourceRevision.js';

const objectId = '507f1f77bcf86cd799439011';
const indexEntries = (model) => model.schema.indexes().map(([keys, options]) => ({ keys, options }));

test('GitHub sync job declares approved states, checkpoint fields, counts, deadline, and expiring lease', () => {
  const job = new GitHubSyncJob({
    project: objectId,
    repositoryLink: '507f1f77bcf86cd799439012',
    installation: '507f1f77bcf86cd799439013',
    requestedBy: '507f1f77bcf86cd799439014',
  });
  assert.equal(job.status, 'running');
  assert.equal(job.stage, 'refresh_installation');
  assert.equal(job.active, true);
  assert.deepEqual(Object.keys(job.checkpoints.toObject()), ['readme', 'commits', 'issues']);
  assert.equal(job.checkpoints.issues.status, 'pending');
  assert.equal(job.counts.rawResponseBytes, 0);
  assert.equal(job.counts.contentBytes, 0);
  assert.ok(job.deadlineAt.getTime() >= job.startedAt.getTime() + GITHUB_SYNC_DEADLINE_MS - 5);
  assert.ok(job.leaseExpiresAt.getTime() >= job.deadlineAt.getTime() + GITHUB_SYNC_LEASE_GRACE_MS - 5);
  assert.ok(indexEntries(GitHubSyncJob).some(({ keys, options }) => (
    keys.repositoryLink === 1 && keys.active === 1
      && options.unique
      && options.name === 'one_active_github_sync_per_repository_link'
      && options.partialFilterExpression?.active === true
  )));
});

test('GitHub sync active marker matches nonterminal status and rejects unsafe error text', async () => {
  const base = {
    project: objectId,
    repositoryLink: '507f1f77bcf86cd799439012',
    installation: '507f1f77bcf86cd799439013',
    requestedBy: '507f1f77bcf86cd799439014',
  };
  for (const status of ['running', 'partial', 'retry_wait']) {
    const job = new GitHubSyncJob({ ...base, status, active: true });
    await job.validate();
  }
  for (const status of ['completed', 'failed']) {
    const job = new GitHubSyncJob({ ...base, status, active: false });
    await job.validate();
  }
  const invalid = new GitHubSyncJob({ ...base, status: 'completed', active: true });
  await assert.rejects(invalid.validate(), /nonterminal GitHub sync jobs/);
  const rawError = new GitHubSyncJob({ ...base, lastErrorCode: 'provider token leaked' });
  await assert.rejects(rawError.validate());
});

test('analysis revision snapshots and source analysis watermark are additive and optional', async () => {
  const legacyJob = new AnalysisJob({ project: objectId, createdBy: objectId, sourceIds: [objectId] });
  assert.equal(legacyJob.sourceRevisionSnapshots, undefined);
  const pinnedJob = new AnalysisJob({
    project: objectId, createdBy: objectId, sourceIds: [objectId],
    sourceRevisionSnapshots: [{ source: objectId, revision: '507f1f77bcf86cd799439015', revisionKey: 'github:readme:sha-a' }],
  });
  await pinnedJob.validate();
  const legacySource = new Source({ project: objectId, originalName: 'legacy.md', uploadedBy: objectId });
  assert.equal(legacySource.analyzedRevision, undefined);
  assert.equal(Source.schema.path('analyzedRevision').options.select, false);
  assert.ok(indexEntries(Source).some(({ keys, options }) => (
    keys.provider === 1 && keys.repositoryLink === 1 && keys.externalType === 1 && keys.externalId === 1
      && options.unique && options.partialFilterExpression?.provider === 'github'
  )));
  assert.ok(indexEntries(SourceRevision).some(({ keys, options }) => (
    keys.source === 1 && keys.revisionKey === 1 && options.unique
  )));
});

test('finding evidence accepts optional source revision and locator without changing legacy evidence', async () => {
  const base = { project: objectId, category: 'Risks', title: 'Risk', description: 'Description' };
  const legacy = new Finding({ ...base, evidence: [{ source: objectId, quote: 'legacy quote' }] });
  await legacy.validate();
  const pinned = new Finding({
    ...base,
    evidence: [{
      source: objectId,
      sourceRevision: '507f1f77bcf86cd799439015',
      locator: { sha: 'abc123', path: 'README.md' },
      quote: 'revision quote',
    }],
  });
  await pinned.validate();
  assert.equal(pinned.evidence[0].sourceRevision.toString(), '507f1f77bcf86cd799439015');
});
