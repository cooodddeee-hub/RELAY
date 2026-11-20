import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canReadProjectAudit, canReviewContradiction, canSignHandover, contradictionEvidenceView,
  contradictionStatusLabel, deletionErrorMessage, isDeletionRecoverable, validateReviewerRationale,
  dashboardMetrics, projectCardMetrics, projectDeletionCardPresentation, validateSignoffInput,
} from '../src/round3WorkflowUi.js';

const owner = 'owner-1';
const reviewer = 'reviewer-1';
const approver = 'approver-1';
const creator = 'creator-1';
const project = {
  owner,
  members: [{ user: reviewer, role: 'viewer' }, { user: approver, role: 'viewer' }],
  workflowPolicy: { reviewMode: 'assigned', signoffMode: 'assigned' },
};
const candidate = { _id: 'candidate-1', status: 'candidate', claims: [{ category: 'Risks' }, { category: 'Risks' }] };

test('contradiction states distinguish suspected, confirmed and dismissed candidates', () => {
  assert.equal(contradictionStatusLabel('candidate'), 'Suspected');
  assert.equal(contradictionStatusLabel('in_review'), 'Suspected · in review');
  assert.equal(contradictionStatusLabel('confirmed_conflict'), 'Confirmed conflict');
  assert.equal(contradictionStatusLabel('dismissed'), 'Dismissed');
});

test('only assigned reviewers covering all candidate categories can review; legacy owner/editor stays compatible', () => {
  const assignment = { role: 'reviewer', status: 'active', user: reviewer, scopeType: 'category', scopeValue: 'Risks' };
  assert.equal(canReviewContradiction({ mode: 'real', project, userId: reviewer, assignments: [assignment], candidate }), true);
  assert.equal(canReviewContradiction({ mode: 'real', project, userId: reviewer, assignments: [], candidate }), false);
  assert.equal(canReviewContradiction({ mode: 'real', project, userId: 'outsider', assignments: [assignment], candidate }), false);
  assert.equal(canReviewContradiction({ mode: 'real', project: { ...project, workflowPolicy: { reviewMode: 'legacy_editors' } }, userId: owner, candidate }), true);
  assert.equal(canReviewContradiction({ mode: 'real', project: { ...project, workflowPolicy: { reviewMode: 'legacy_editors' } }, userId: reviewer, candidate }), false);
});

test('candidate evidence display retains source, immutable revision, locator and verified exact passage', () => {
  const view = contradictionEvidenceView({
    source: { originalName: 'README.md' },
    sourceRevision: { revisionKey: 'readme-sha-123', locator: { repositoryFullName: 'org/repo', path: 'README.md' } },
    quote: 'exact words', matchedText: 'exact words',
  });
  assert.deepEqual(view, { sourceName: 'README.md', revisionKey: 'readme-sha-123', locator: 'org/repo · README.md', verifiedText: 'exact words', verified: true });
});

test('review rationale and signoff inputs reject blank and oversized text', () => {
  assert.equal(validateReviewerRationale('  ').valid, false);
  assert.equal(validateReviewerRationale('  reviewed both revisions  ').value, 'reviewed both revisions');
  assert.equal(validateReviewerRationale('x'.repeat(2001)).valid, false);
  assert.equal(validateSignoffInput({ decision: 'approved', comment: '' }).valid, false);
  assert.equal(validateSignoffInput({ decision: 'approved', comment: ' Approved ' }).comment, 'Approved');
  assert.equal(validateSignoffInput({ decision: 'rejected', comment: 'Reviewed', reason: '' }).valid, false);
  assert.equal(validateSignoffInput({ decision: 'rejected', comment: 'Reviewed', reason: 'Needs more evidence' }).valid, true);
});

test('only assigned approvers can sign a current pending version, excluding creator and superseded versions', () => {
  const handover = { _id: 'handover-2', createdBy: creator, approvalStatus: 'pending', effectiveStatus: 'pending' };
  const assignment = { role: 'approver', status: 'active', user: approver, scopeType: 'project' };
  assert.equal(canSignHandover({ mode: 'real', project, userId: approver, assignments: [assignment], handover }), true);
  assert.equal(canSignHandover({ mode: 'real', project, userId: creator, assignments: [assignment], handover }), false);
  assert.equal(canSignHandover({ mode: 'real', project, userId: approver, assignments: [], handover }), false);
  assert.equal(canSignHandover({ mode: 'real', project, userId: approver, assignments: [assignment], handover: { ...handover, effectiveStatus: 'superseded' } }), false);
});

test('signoff is disabled for legacy workflow and audit history is restricted to owner or audit reader', () => {
  assert.equal(canSignHandover({ mode: 'real', project: { ...project, workflowPolicy: { signoffMode: 'none' } }, userId: approver, handover: { _id: 'h', createdBy: creator, approvalStatus: 'pending' } }), false);
  assert.equal(canReadProjectAudit({ mode: 'real', project, userId: owner }), true);
  assert.equal(canReadProjectAudit({ mode: 'real', project, userId: reviewer }), false);
  assert.equal(canReadProjectAudit({ mode: 'real', project, userId: reviewer, assignments: [{ role: 'audit_reader', status: 'active', user: reviewer, scopeType: 'project' }] }), true);
});

test('project recovery is available only during queued 30-day recovery, and cleanup errors are safe', () => {
  const deletion = { deletionState: 'queued', recoveryEndsAt: new Date(10_000).toISOString(), job: { status: 'retry_wait' } };
  assert.equal(isDeletionRecoverable(deletion, 9_999), true);
  assert.equal(isDeletionRecoverable(deletion, 10_000), false);
  assert.equal(isDeletionRecoverable({ ...deletion, deletionState: 'purging' }, 1), false);
  assert.equal(isDeletionRecoverable({ ...deletion, job: { status: 'running' } }, 1), false);
  assert.match(deletionErrorMessage('OBJECT_STORAGE_DELETE_FAILED'), /Private storage/);
  assert.doesNotMatch(deletionErrorMessage('unrecognized'), /token|secret|payload/i);
});

test('project cards expose tombstone state, recovery deadline and route to owner settings', () => {
  const card = projectDeletionCardPresentation({ deletionState: 'queued', deletionRequestedAt: '2026-01-01T00:00:00.000Z' }, Date.parse('2026-01-30T23:59:59.000Z'));
  assert.equal(card.label, 'RECOVERABLE · DELETING');
  assert.equal(card.recoverable, true);
  assert.equal(card.destination, 'settings');
  assert.equal(card.recoveryEndsAt.toISOString(), '2026-01-31T00:00:00.000Z');
  assert.equal(projectDeletionCardPresentation({ deletionState: 'queued', deletionRequestedAt: '2026-01-01T00:00:00.000Z' }, Date.parse('2026-02-01T00:00:00.000Z')).label, 'DELETION QUEUED');
  assert.equal(projectDeletionCardPresentation({ deletionState: 'purging' }).label, 'CLEANUP IN PROGRESS');
  assert.equal(projectDeletionCardPresentation({}).destination, 'sources');
});

test('dashboard and selected project cards use live project-scoped counts', () => {
  const projects = [
    { status: 'review' },
    { status: 'completed' },
    { deletionState: 'queued', status: 'active' },
  ];
  const findings = [{ status: 'pending' }, { status: 'approved' }, { status: 'rejected' }];
  assert.deepEqual(dashboardMetrics(projects, findings), {
    activeProjects: 2, inReviewProjects: 1, completedProjects: 1, recoveryProjects: 1,
    pendingFindings: 1, approvedFindings: 1,
  });
  assert.deepEqual(projectCardMetrics({ owner, members: [{ user: reviewer }, { user: owner }] }, {
    selected: true, sources: [{}, {}], findings, findingsUnavailable: false,
  }), { teamMembers: 2, sources: 2, findings: 3, pending: 1 });
  assert.equal(projectCardMetrics({}, { selected: false }).sources, null);
  assert.equal(projectCardMetrics({}, { selected: true, sourcesUnavailable: true }).sources, null);
  assert.equal(projectCardMetrics({}, { selected: true, findingsUnavailable: true }).pending, null);
});
