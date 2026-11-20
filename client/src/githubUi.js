export function isProjectOwner(project, userId) {
  return Boolean(project && userId && String(project.owner) === String(userId));
}

const validTagName = /^[a-z][a-z0-9-]*$/i;

export function createUiNode(documentRef, tagName, text, className) {
  if (typeof tagName !== 'string' || !validTagName.test(tagName)) {
    throw new TypeError('UI element tag name must be a valid HTML tag.');
  }
  const element = documentRef.createElement(tagName);
  if (text !== undefined && text !== null) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}

export function createGitHubActionButton(documentRef, label, className) {
  const button = createUiNode(documentRef, 'button', label, className);
  button.type = 'button';
  return button;
}

export function githubInstallationStatusLabel(installation) {
  if (installation?.status === 'unverified' && installation?.lastKnownStatus === 'active') return 'Active · verification stale';
  if (installation?.status === 'active') return 'Active';
  if (installation?.status === 'suspended') return 'Suspended';
  if (installation?.status === 'removed') return 'Removed';
  return 'Status unavailable';
}

export function canSyncGitHubRepository(repository, project, userId) {
  return isProjectOwner(project, userId)
    && repository?.status !== 'unlinked'
    && repository?.connectionStatus !== 'needs_reauthorization';
}

export function canRetryGitHubSync(repository, project, userId, now = Date.now()) {
  const job = repository?.latestSyncJob;
  return canSyncGitHubRepository(repository, project, userId)
    && Boolean(job?.retryable)
    && (!job.retryAt || new Date(job.retryAt).getTime() <= now);
}

export function githubConnectionLabel(repository) {
  if (repository?.status === 'unlinked' || repository?.connectionStatus === 'unlinked') return 'Unlinked';
  if (repository?.connectionStatus === 'needs_reauthorization') return 'Needs reauthorization';
  if (repository?.connectionStatus === 'needs_verification') return 'Status needs verification';
  return 'Connected';
}

export function githubSyncStatusLabel(job) {
  const status = job?.status;
  return ({
    running: 'Running', completed: job?.resultCompleteness === 'partial' ? 'Partial' : 'Completed',
    partial: 'Partial', failed: 'Failed', retry_wait: 'Retry available', interrupted: 'Interrupted · retry available',
  })[status] || '';
}

export function githubSyncStageLabel(stage) {
  return ({ readme: 'README', commits: 'Commits', issues: 'Issues', finalize: 'Finalizing', refresh_installation: 'Verifying GitHub access' })[stage] || 'Waiting to start';
}

export function githubSyncErrorMessage(code) {
  return ({
    GITHUB_INSTALLATION_UNAVAILABLE: 'The GitHub installation is unavailable. Ask the project owner to reauthorize it.',
    GITHUB_INSTALLATION_SUSPENDED: 'The GitHub App installation is suspended. Reauthorize it after restoring access.',
    GITHUB_INSTALLATION_REMOVED: 'The GitHub App was removed. Reinstall and reauthorize it before syncing.',
    GITHUB_REPOSITORY_ACCESS_UNAVAILABLE: 'GitHub could not verify access to this repository. Check the installation permissions and repository selection.',
    GITHUB_REPOSITORY_UNLINKED: 'This repository was unlinked before sync could finish.',
    PROJECT_OWNER_CHANGED: 'Project ownership changed before this sync could finish. The new owner can start a new sync.',
    GITHUB_RATE_LIMITED: 'GitHub rate-limited this request. Retry after the displayed retry time.',
    GITHUB_TIMEOUT: 'GitHub took too long to respond. Completed checkpoints were saved and can be retried.',
    GITHUB_SYNC_DEADLINE: 'The sync reached its safe time limit. Completed checkpoints were saved and can be retried.',
    GITHUB_UNAVAILABLE: 'GitHub is temporarily unavailable. Completed checkpoints were saved and can be retried.',
  })[code] || 'GitHub sync did not complete. Check the repository connection and try again.';
}
