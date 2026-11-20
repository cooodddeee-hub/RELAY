import test from 'node:test';
import assert from 'node:assert/strict';
import { findContradictionPairs, transitionContradiction } from '../src/services/contradictions.js';

function finding(id, description, sourceRevision = `revision-${id}`) {
  return {
    _id: id, category: 'Decision', title: 'Launch date', description,
    evidence: [{ source: `source-${id}`, sourceRevision, verificationStatus: 'verified', quote: description }],
  };
}

test('conservatively proposes only cross-revision evidence with same-topic numeric or polarity conflict', () => {
  assert.equal(findContradictionPairs([
    finding('one', 'The release is scheduled for June 5.'),
    finding('two', 'The release is scheduled for July 6.'),
  ]).length, 1);
  assert.equal(findContradictionPairs([
    finding('one', 'The release is scheduled for June 5.', 'same-revision'),
    finding('two', 'The release is scheduled for July 6.', 'same-revision'),
  ]).length, 0);
  assert.equal(findContradictionPairs([
    finding('one', 'The beta is available to users.'),
    finding('two', 'The beta is not available to users.'),
  ]).length, 1);
  assert.equal(findContradictionPairs([
    finding('one', 'The beta is available to users.'),
    { ...finding('two', 'The final launch is tomorrow.'), title: 'Final launch' },
  ]).length, 0);
});

test('contradiction lifecycle permits human decisions only and preserves terminal decisions', () => {
  const candidate = { status: 'candidate' };
  transitionContradiction(candidate, 'in_review', 'reviewer-id', 'Started review.');
  assert.equal(candidate.status, 'in_review');
  transitionContradiction(candidate, 'confirmed_conflict', 'reviewer-id', 'Both dated claims are independently evidenced.');
  assert.equal(candidate.status, 'confirmed_conflict');
  assert.equal(candidate.reviewReason, 'Both dated claims are independently evidenced.');
  assert.throws(() => transitionContradiction(candidate, 'dismissed', 'reviewer-id', 'Changed mind.'), { status: 409 });
});
