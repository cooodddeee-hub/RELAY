import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assignmentScopeQuery, canReviewFinding, isCurrentProjectMember, isReviewerScopeMatch, normalizeAssignmentInput,
  ProjectAssignmentError,
} from '../src/services/projectAssignments.js';

const ids = {
  project: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  owner: 'bbbbbbbbbbbbbbbbbbbbbbbb',
  editor: 'cccccccccccccccccccccccc',
  viewer: 'dddddddddddddddddddddddd',
  outsider: 'eeeeeeeeeeeeeeeeeeeeeeee',
};
const project = (workflowPolicy = { reviewMode: 'assigned' }) => ({
  _id: ids.project,
  owner: ids.owner,
  members: [{ user: ids.editor, role: 'editor' }, { user: ids.viewer, role: 'viewer' }],
  workflowPolicy,
});

test('validates project-wide, category, and handover assignment scopes', () => {
  assert.deepEqual(normalizeAssignmentInput({ role: 'reviewer' }), { role: 'reviewer', scopeType: 'project', scopeValue: '' });
  assert.deepEqual(normalizeAssignmentInput({ role: 'approver', scopeType: 'category', scopeValue: 'Risks' }), {
    role: 'approver', scopeType: 'category', scopeValue: 'Risks',
  });
  assert.throws(() => normalizeAssignmentInput({ role: 'editor' }), ProjectAssignmentError);
  assert.throws(() => normalizeAssignmentInput({ role: 'reviewer', scopeType: 'category', scopeValue: 'unknown' }), ProjectAssignmentError);
  assert.throws(() => normalizeAssignmentInput({ role: 'approver', scopeType: 'handover', scopeValue: 'bad-id' }), ProjectAssignmentError);
});

test('reviewer scope does not grant unrelated category or project-edit access', () => {
  const assigned = [{ project: ids.project, user: ids.viewer, role: 'reviewer', scopeType: 'category', scopeValue: 'Decision', status: 'active' }];
  assert.equal(isCurrentProjectMember(project(), ids.viewer), true);
  assert.equal(isCurrentProjectMember(project(), ids.outsider), false);
  assert.equal(canReviewFinding(project(), ids.viewer, { category: 'Decision' }, assigned), true);
  assert.equal(canReviewFinding(project(), ids.viewer, { category: 'Risks' }, assigned), false);
  assert.equal(canReviewFinding(project(), ids.editor, { category: 'Decision' }, []), false);
  assert.equal(canReviewFinding(project(), ids.owner, { category: 'Decision' }, []), false);
  assert.equal(isReviewerScopeMatch({ ...assigned[0], role: 'approver' }, { category: 'Decision' }), false);
});

test('legacy review mode keeps owner/editor behavior and does not promote a viewer', () => {
  const legacy = project({ reviewMode: 'legacy_editors' });
  assert.equal(canReviewFinding(legacy, ids.owner, { category: 'Decision' }), true);
  assert.equal(canReviewFinding(legacy, ids.editor, { category: 'Decision' }), true);
  assert.equal(canReviewFinding(legacy, ids.viewer, { category: 'Decision' }), false);
  assert.equal(canReviewFinding(legacy, ids.outsider, { category: 'Decision' }), false);
});

test('review assignment queries are constrained to project, user, active status, role, and applicable scope', () => {
  assert.deepEqual(assignmentScopeQuery({ projectId: ids.project, userId: ids.viewer, role: 'reviewer', category: 'Decision' }), {
    project: ids.project,
    user: ids.viewer,
    role: 'reviewer',
    status: 'active',
    $or: [{ scopeType: 'project' }, { scopeType: 'category', scopeValue: 'Decision' }],
  });
});
