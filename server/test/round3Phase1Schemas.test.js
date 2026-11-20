import test from 'node:test';
import assert from 'node:assert/strict';
import Project from '../src/models/Project.js';
import Source from '../src/models/Source.js';
import ProjectAssignment from '../src/models/ProjectAssignment.js';
import SourceRevision from '../src/models/SourceRevision.js';
import ContradictionCandidate from '../src/models/ContradictionCandidate.js';
import HandoverSignoff from '../src/models/HandoverSignoff.js';
import AuditEvent from '../src/models/AuditEvent.js';
import ProjectDeletionJob from '../src/models/ProjectDeletionJob.js';
import Handover from '../src/models/Handover.js';
import GitHubInstallation from '../src/models/GitHubInstallation.js';
import GitHubInstallState from '../src/models/GitHubInstallState.js';
import ProjectRepository from '../src/models/ProjectRepository.js';
import { retentionExpiry } from '../src/config/retention.js';

test('legacy project and upload documents resolve additive Phase 1 defaults', () => {
  const project = new Project({ name: 'Legacy project', owner: '507f1f77bcf86cd799439011' });
  const source = new Source({ project: project._id, originalName: 'notes.md', uploadedBy: project.owner });
  assert.equal(project.workflowPolicy.reviewMode, 'legacy_editors');
  assert.equal(project.workflowPolicy.signoffMode, 'none');
  assert.equal(source.provider, 'upload');
  assert.equal(source.extractedText, '');
});

test('Phase 1 foundational collections declare expected uniqueness and retention indexes', () => {
  const indexKeys = (model) => model.schema.indexes().map(([keys, options]) => ({ keys, options }));
  assert.ok(indexKeys(Handover).some(({ keys, options }) => keys.project === 1 && keys.version === 1 && options.unique));
  assert.ok(indexKeys(ProjectAssignment).some(({ options }) => options.unique && options.partialFilterExpression?.status === 'active'));
  assert.ok(indexKeys(SourceRevision).some(({ keys, options }) => keys.source === 1 && keys.revisionKey === 1 && options.unique));
  assert.ok(indexKeys(ContradictionCandidate).some(({ keys, options }) => keys.project === 1 && keys.candidateKey === 1 && options.unique));
  for (const model of [AuditEvent, HandoverSignoff]) {
    assert.ok(indexKeys(model).some(({ keys, options }) => keys.expiresAt === 1 && options.expireAfterSeconds === 0));
  }
  assert.ok(indexKeys(ProjectDeletionJob).some(({ keys, options }) => keys.projectId === 1 && options.unique));
});

test('Phase 3 GitHub schemas enforce installation, one-time state, and project repository uniqueness', () => {
  const indexKeys = (model) => model.schema.indexes().map(([keys, options]) => ({ keys, options }));
  assert.ok(indexKeys(GitHubInstallation).some(({ keys, options }) => keys.installationId === 1 && options.unique));
  assert.ok(indexKeys(GitHubInstallState).some(({ keys, options }) => keys.stateHash === 1 && options.unique));
  assert.ok(indexKeys(GitHubInstallState).some(({ keys, options }) => keys.expiresAt === 1 && options.expireAfterSeconds === 0));
  assert.ok(indexKeys(ProjectRepository).some(({ keys, options }) => keys.project === 1 && keys.repositoryId === 1 && keys.status === 1 && options.unique && options.partialFilterExpression?.status === 'active'));
});

test('contradiction candidates require multiple evidence records and confidence bounds', async () => {
  const candidate = new ContradictionCandidate({
    project: '507f1f77bcf86cd799439011', candidateKey: 'timeline',
    claims: [{ summary: 'Claim A' }, { summary: 'Claim B' }],
    evidence: [{ source: '507f1f77bcf86cd799439012', sourceRevision: '507f1f77bcf86cd799439013', quote: 'A' }],
    relationship: 'possible_conflict', cautiousLabel: 'needs_human_check', confidenceBand: 'high', confidence: 1.1,
    explanation: 'Potential conflict',
  });
  const error = await candidate.validate().then(() => null, (validationError) => validationError);
  assert.ok(error);
  assert.ok(error.errors.evidence || error.errors.confidence);
});

test('retention expiry requires an explicit positive configured period', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  assert.equal(retentionExpiry('audit', { now, env: { AUDIT_RETENTION_DAYS: '30' } }).toISOString(), '2026-01-31T00:00:00.000Z');
  assert.throws(() => retentionExpiry('signoff', { now, env: {} }), { code: 'RETENTION_CONFIGURATION_INVALID' });
  assert.throws(() => retentionExpiry('audit', { now, env: { AUDIT_RETENTION_DAYS: '0' } }), { code: 'RETENTION_CONFIGURATION_INVALID' });
});
