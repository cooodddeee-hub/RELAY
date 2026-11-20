import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveHandoverStatus, validateSignoffDecision } from '../src/services/handoverSignoff.js';

const handover = { _id: 'handover-1', version: 2, createdBy: 'creator', approvalStatus: 'pending' };

test('pending handover status is computed as superseded without changing stored status', () => {
  assert.equal(effectiveHandoverStatus(handover, 3), 'superseded');
  assert.equal(handover.approvalStatus, 'pending');
  assert.equal(effectiveHandoverStatus(handover, 2), 'pending');
});

test('sign-off requires independent approver, pending current version, comment and rejection reason', () => {
  assert.throws(() => validateSignoffDecision({ handover, latestVersion: 2, actorId: 'creator', decision: 'approved', comment: 'Looks good.' }), { status: 403 });
  assert.throws(() => validateSignoffDecision({ handover, latestVersion: 3, actorId: 'approver', decision: 'approved', comment: 'Looks good.' }), { status: 409 });
  assert.throws(() => validateSignoffDecision({ handover, latestVersion: 2, actorId: 'approver', decision: 'approved', comment: '' }), { status: 400 });
  assert.throws(() => validateSignoffDecision({ handover, latestVersion: 2, actorId: 'approver', decision: 'rejected', comment: 'Decision recorded.' }), { status: 400 });
  assert.doesNotThrow(() => validateSignoffDecision({ handover, latestVersion: 2, actorId: 'approver', decision: 'rejected', comment: 'Decision recorded.', reason: 'Missing evidence.' }));
});
