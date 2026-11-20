import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canRetryGitHubSync, canSyncGitHubRepository, createGitHubActionButton, createUiNode, githubConnectionLabel,
  githubInstallationStatusLabel, githubSyncErrorMessage, githubSyncStageLabel, githubSyncStatusLabel, isProjectOwner,
} from '../src/githubUi.js';

const project = { owner: 'owner-id', members: [{ user: 'editor-id', role: 'editor' }, { user: 'viewer-id', role: 'viewer' }] };
const linked = { status: 'active', connectionStatus: 'active', latestSyncJob: { status: 'partial', retryable: true } };

test('only the current project owner receives GitHub sync and retry controls', () => {
  assert.equal(isProjectOwner(project, 'owner-id'), true);
  assert.equal(canSyncGitHubRepository(linked, project, 'owner-id'), true);
  assert.equal(canRetryGitHubSync(linked, project, 'owner-id'), true);
  for (const userId of ['editor-id', 'viewer-id', 'reviewer-id', 'approver-id', 'outsider-id']) {
    assert.equal(canSyncGitHubRepository(linked, project, userId), false);
    assert.equal(canRetryGitHubSync(linked, project, userId), false);
  }
});

test('GitHub repository sync action renders its dynamic label as button text, not an element tag', () => {
  const createdTags = [];
  const documentStub = {
    createElement(tagName) {
      assert.match(tagName, /^[a-z][a-z0-9-]*$/i, 'GitHub UI must create valid HTML tags');
      createdTags.push(tagName);
      return { tagName, type: '', textContent: '', className: '' };
    },
  };
  const button = createGitHubActionButton(documentStub, 'Sync GitHub', 'github-sync-button');
  assert.equal(button.tagName, 'button');
  assert.equal(button.textContent, 'Sync GitHub');
  assert.equal(button.className, 'github-sync-button');
  assert.deepEqual(createdTags, ['button']);
  assert.throws(() => createUiNode(documentStub, 'Sync GitHub', 'ignored', ''), /valid HTML tag/);
  assert.deepEqual(createdTags, ['button'], 'invalid labels must be rejected before document.createElement');
});

test('installation status distinguishes stale verification from verified active, suspended and removed states', () => {
  assert.equal(githubInstallationStatusLabel({ status: 'active' }), 'Active');
  assert.equal(githubInstallationStatusLabel({ status: 'unverified', lastKnownStatus: 'active' }), 'Active · verification stale');
  assert.equal(githubInstallationStatusLabel({ status: 'suspended' }), 'Suspended');
  assert.equal(githubInstallationStatusLabel({ status: 'removed' }), 'Removed');
});

test('sync control respects unlinked and reauthorization states while allowing stale status refresh via sync', () => {
  assert.equal(canSyncGitHubRepository({ ...linked, status: 'unlinked', connectionStatus: 'unlinked' }, project, 'owner-id'), false);
  assert.equal(canSyncGitHubRepository({ ...linked, connectionStatus: 'needs_reauthorization' }, project, 'owner-id'), false);
  assert.equal(canSyncGitHubRepository({ ...linked, connectionStatus: 'needs_verification' }, project, 'owner-id'), true);
  assert.equal(githubConnectionLabel({ status: 'unlinked' }), 'Unlinked');
  assert.equal(githubConnectionLabel({ connectionStatus: 'needs_reauthorization' }), 'Needs reauthorization');
  assert.equal(githubConnectionLabel({ connectionStatus: 'needs_verification' }), 'Status needs verification');
});

test('status and stage labels preserve partial and retry distinctions', () => {
  assert.equal(githubSyncStatusLabel({ status: 'completed', resultCompleteness: 'partial' }), 'Partial');
  assert.equal(githubSyncStatusLabel({ status: 'retry_wait' }), 'Retry available');
  assert.equal(githubSyncStatusLabel({ status: 'interrupted' }), 'Interrupted · retry available');
  assert.equal(githubSyncStageLabel('issues'), 'Issues');
  assert.equal(githubSyncStageLabel('finalize'), 'Finalizing');
});

test('retry timing is honored and provider error codes map to safe user messages', () => {
  const retry = { ...linked, latestSyncJob: { status: 'retry_wait', retryable: true, retryAt: '2026-11-17T11:00:00.000Z' } };
  assert.equal(canRetryGitHubSync(retry, project, 'owner-id', Date.parse('2026-11-17T10:59:00.000Z')), false);
  assert.equal(canRetryGitHubSync(retry, project, 'owner-id', Date.parse('2026-11-17T11:01:00.000Z')), true);
  assert.match(githubSyncErrorMessage('GITHUB_SYNC_DEADLINE'), /checkpoints were saved/);
  assert.doesNotMatch(githubSyncErrorMessage('provider-private-error'), /token|secret|payload/i);
});
