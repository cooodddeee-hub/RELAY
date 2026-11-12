import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCanReviewProject, ReviewWorkflowError, runReviewAction } from '../src/services/reviewWorkflow.js';
import { createHandoverSnapshot } from '../src/services/handoverReport.js';

function fixture(overrides = {}) {
  const database = {
    finding: {
      _id: 'finding-1', project: 'project-1', status: 'pending', title: 'Original title',
      description: 'Original description', category: 'Decision', confidence: 0.9,
      evidence: [{ source: 'source-1', quote: 'Original quote', verificationStatus: 'unverified' }], reviewerComments: [],
      ...overrides,
    },
    history: [],
  };
  const transaction = (work) => work({
    findFinding: async (id, projectId) => id === database.finding._id && projectId === database.finding.project ? database.finding : null,
    saveFinding: async (finding) => { database.finding = finding; },
    appendHistory: async (entry) => { database.history.push({ ...entry, _id: `history-${database.history.length + 1}`, createdAt: new Date() }); },
  });
  const act = (action, payload = {}, actorId = 'reviewer-1') => runReviewAction({ findingId: 'finding-1', projectId: 'project-1', actorId, action, payload, transaction });
  return { database, act };
}

test('approves a pending finding and persists an audit record', async () => {
  const { database, act } = fixture();
  const finding = await act('approve');
  assert.equal(finding.status, 'approved');
  assert.equal(String(finding.reviewedBy), 'reviewer-1');
  assert.equal(database.history.length, 1);
  assert.equal(database.history[0].action, 'approved');
  assert.equal(database.history[0].previousValues.status, 'pending');
  assert.equal(database.history[0].updatedValues.status, 'approved');
});

test('rejects without a reason and accepts a rejection with a reason', async () => {
  const missing = fixture();
  await assert.rejects(missing.act('reject'), (error) => error instanceof ReviewWorkflowError && error.status === 400 && /reason is required/.test(error.message));
  assert.equal(missing.database.history.length, 0);

  const valid = fixture();
  const finding = await valid.act('reject', { reason: 'The claim conflicts with the release record.' });
  assert.equal(finding.status, 'rejected');
  assert.equal(valid.database.history[0].reason, 'The claim conflicts with the release record.');
  assert.equal(finding.reviewerComments[0].comment, valid.database.history[0].reason);
});

test('edits finding fields without altering evidence verification metadata', async () => {
  const { database, act } = fixture();
  const oldEvidence = structuredClone(database.finding.evidence);
  const finding = await act('edit', { title: 'Updated decision', description: 'Revised details.' });
  assert.equal(finding.title, 'Updated decision');
  assert.equal(finding.description, 'Revised details.');
  assert.deepEqual(finding.evidence, oldEvidence);
  assert.equal(database.history[0].action, 'edited');
  assert.equal(database.history[0].previousValues.title, 'Original title');
  assert.equal(database.history[0].updatedValues.title, 'Updated decision');
});

test('requires a clarification comment', async () => {
  const { database, act } = fixture();
  await assert.rejects(act('clarify'), (error) => error instanceof ReviewWorkflowError && /comment is required/.test(error.message));
  assert.equal(database.history.length, 0);
});

test('returns a clarification-needed finding to pending after an edit', async () => {
  const { database, act } = fixture({ status: 'needs_clarification' });
  const finding = await act('edit', { description: 'Updated after clarification.' });
  assert.equal(finding.status, 'pending');
  assert.equal(finding.description, 'Updated after clarification.');
  assert.equal(database.history[0].action, 'returned_to_pending');
  assert.equal(database.history[0].previousValues.status, 'needs_clarification');
  assert.equal(database.history[0].updatedValues.status, 'pending');
});

test('only project owners and editors may review; viewers and unrelated users are denied', () => {
  const project = { owner: 'owner-1', members: [{ user: 'editor-1', role: 'editor' }, { user: 'viewer-1', role: 'viewer' }] };
  assert.doesNotThrow(() => assertCanReviewProject(project, 'owner-1'));
  assert.doesNotThrow(() => assertCanReviewProject(project, 'editor-1'));
  assert.throws(() => assertCanReviewProject(project, 'viewer-1'), (error) => error.status === 403);
  assert.throws(() => assertCanReviewProject(project, 'outsider'), (error) => error.status === 403);
});

test('review history remains retrievable and records reviewer, project and timestamp', async () => {
  const { database, act } = fixture();
  await act('clarify', { comment: 'Please link the decision record.' });
  const history = database.history.filter((entry) => entry.finding === 'finding-1' && entry.project === 'project-1');
  assert.equal(history.length, 1);
  assert.equal(history[0].reviewer, 'reviewer-1');
  assert.equal(history[0].action, 'clarification_requested');
  assert.ok(history[0].createdAt instanceof Date);
  assert.equal(history[0].comment, 'Please link the decision record.');
});

test('rejects invalid transitions and conflicting repeat actions', async () => {
  const { act } = fixture({ status: 'approved' });
  await assert.rejects(act('reject', { reason: 'Changed my mind.' }), (error) => error.status === 409);
  await assert.rejects(act('approve'), (error) => error.status === 409);
});

test('owners and editors can reopen an approved finding with an audited reason', async () => {
  const project = { owner: 'owner-1', members: [{ user: 'editor-1', role: 'editor' }] };
  for (const reviewer of ['owner-1', 'editor-1']) {
    assert.doesNotThrow(() => assertCanReviewProject(project, reviewer));
    const { database, act } = fixture({ status: 'approved' });
    const finding = await act('reopen', { reason: 'The source supports a different category.' }, reviewer);
    assert.equal(finding.status, 'pending');
    assert.equal(database.history[0].action, 'reopened');
    assert.equal(database.history[0].reviewer, reviewer);
    assert.equal(database.history[0].previousValues.status, 'approved');
    assert.equal(database.history[0].updatedValues.status, 'pending');
    assert.equal(database.history[0].reason, 'The source supports a different category.');
  }
});

test('reopening requires a non-empty reason and only applies to approved findings', async () => {
  const missingReason = fixture({ status: 'approved' });
  await assert.rejects(missingReason.act('reopen'), (error) => error instanceof ReviewWorkflowError && /reason is required/.test(error.message));
  await assert.rejects(missingReason.act('reopen', { reason: '   ' }), (error) => error instanceof ReviewWorkflowError && /reason is required/.test(error.message));
  assert.equal(missingReason.database.finding.status, 'approved');
  assert.equal(missingReason.database.history.length, 0);

  const pending = fixture();
  await assert.rejects(pending.act('reopen', { reason: 'Correction.' }), (error) => error.status === 409);
  assert.equal(pending.database.history.length, 0);
});

test('viewers and non-members cannot reopen findings', () => {
  const project = { owner: 'owner-1', members: [{ user: 'editor-1', role: 'editor' }, { user: 'viewer-1', role: 'viewer' }] };
  assert.throws(() => assertCanReviewProject(project, 'viewer-1'), (error) => error.status === 403);
  assert.throws(() => assertCanReviewProject(project, 'outsider'), (error) => error.status === 403);
});

test('reopened finding can be edited and must be approved again without losing audit history', async () => {
  const { database, act } = fixture({ status: 'approved', category: 'Dependencies' });
  const earlierApproval = { action: 'approved', previousValues: { status: 'pending' }, updatedValues: { status: 'approved' }, reviewer: 'reviewer-before', createdAt: new Date('2026-01-01T00:00:00Z') };
  database.history.push(earlierApproval);

  await act('reopen', { reason: 'Correct the finding category.' });
  assert.equal(database.finding.status, 'pending');
  const edited = await act('edit', { category: 'Decision' });
  assert.equal(edited.status, 'pending');
  assert.equal(edited.category, 'Decision');
  const approved = await act('approve');
  assert.equal(approved.status, 'approved');
  assert.deepEqual(database.history.map((entry) => entry.action), ['approved', 'reopened', 'edited', 'approved']);
  assert.equal(database.history[0], earlierApproval);
});

test('reopening, editing and reapproval do not mutate an existing handover snapshot', async () => {
  const { database, act } = fixture({ status: 'approved', category: 'Dependencies' });
  const snapshot = createHandoverSnapshot({
    project: { _id: 'project-1', name: 'Project', description: 'Saved snapshot' },
    approvedFindings: [database.finding], version: 2, generatedBy: { _id: 'reviewer-1', name: 'Reviewer' },
  });
  const savedSnapshot = structuredClone(snapshot);

  await act('reopen', { reason: 'Correct the category.' });
  await act('edit', { category: 'Decision' });
  await act('approve');
  assert.deepEqual(snapshot, savedSnapshot);
});
