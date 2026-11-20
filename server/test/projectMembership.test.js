import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCanReviewProject, canManageProjectMembers, canReadProject } from '../src/services/projectPermissions.js';
import { normalizeMemberEmail, prepareMemberAddition, prepareMemberRemoval, prepareMemberRoleChange, ProjectMembershipError, validateMemberRole, visibleProjectsFilter } from '../src/services/projectMembership.js';

const ownerId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const editorId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const viewerId = 'cccccccccccccccccccccccc';
const outsiderId = 'dddddddddddddddddddddddd';
const project = () => ({ _id: 'project-one', owner: ownerId, members: [{ user: ownerId, role: 'owner' }, { user: editorId, role: 'editor' }, { user: viewerId, role: 'viewer' }] });

test('owner can add an existing registered user with a selected role', () => {
  const addition = prepareMemberAddition(project(), { _id: outsiderId, email: 'new.member@example.com' }, validateMemberRole('editor'));
  assert.deepEqual(addition, { user: outsiderId, role: 'editor' });
});

test('unknown email fails without exposing account details', () => {
  assert.throws(() => prepareMemberAddition(project(), null, 'viewer'), (error) => error.status === 404 && error.message === 'No registered RELAY account was found for that email.');
});

test('normalizes member email and rejects invalid email and role values', () => {
  assert.equal(normalizeMemberEmail('  New.Member@Example.com '), 'new.member@example.com');
  assert.throws(() => normalizeMemberEmail('not-an-email'), ProjectMembershipError);
  assert.throws(() => validateMemberRole('owner'), ProjectMembershipError);
});

test('duplicate membership is rejected', () => {
  assert.throws(() => prepareMemberAddition(project(), { _id: editorId }, 'viewer'), (error) => error.status === 409);
});

test('owner can change an Editor or Viewer role', () => {
  assert.deepEqual(prepareMemberRoleChange(project(), editorId, 'viewer'), { user: editorId, previousRole: 'editor', role: 'viewer' });
  assert.deepEqual(prepareMemberRoleChange(project(), viewerId, 'editor'), { user: viewerId, previousRole: 'viewer', role: 'editor' });
});

test('owner can remove a project member but cannot remove or demote the owner', () => {
  assert.deepEqual(prepareMemberRemoval(project(), editorId), { user: editorId, role: 'editor' });
  assert.throws(() => prepareMemberRemoval(project(), ownerId), (error) => error.status === 400);
  assert.throws(() => prepareMemberRoleChange(project(), ownerId, 'viewer'), (error) => error.status === 400);
});

test('editors, viewers, and non-members cannot manage project membership', () => {
  for (const userId of [editorId, viewerId, outsiderId]) assert.equal(canManageProjectMembers(project(), userId), false);
  assert.equal(canManageProjectMembers(project(), ownerId), true);
});

test('non-members cannot read; shared members and the existing owner retain access', () => {
  const query = visibleProjectsFilter(viewerId);
  assert.deepEqual(query, {
    $and: [
      { $or: [{ owner: viewerId }, { 'members.user': viewerId }] },
      { $or: [{ deletionState: 'active' }, { deletionState: { $exists: false } }, { owner: viewerId }] },
    ],
  });
  assert.equal(canReadProject(project(), ownerId), true);
  assert.equal(canReadProject(project(), viewerId), true);
  assert.equal(canReadProject(project(), outsiderId), false);
  assert.equal(canReadProject({ owner: ownerId, members: [{ user: viewerId }] }, viewerId), true);
  assert.equal(canManageProjectMembers({ owner: ownerId, members: [{ user: editorId }] }, viewerId), false);
});

test('viewer cannot perform review actions', () => {
  assert.throws(() => assertCanReviewProject(project(), viewerId), (error) => error.status === 403);
  assert.doesNotThrow(() => assertCanReviewProject(project(), editorId));
  assert.doesNotThrow(() => assertCanReviewProject(project(), ownerId));
});

test('cross-project member changes fail because the target is not a member of that project', () => {
  const secondProject = { _id: 'project-two', owner: outsiderId, members: [{ user: outsiderId, role: 'owner' }] };
  assert.throws(() => prepareMemberRoleChange(secondProject, editorId, 'viewer'), (error) => error.status === 404);
  assert.throws(() => prepareMemberRemoval(secondProject, viewerId), (error) => error.status === 404);
});
