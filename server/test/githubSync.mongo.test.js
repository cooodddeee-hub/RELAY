import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import User from '../src/models/User.js';
import Project from '../src/models/Project.js';
import AuditEvent from '../src/models/AuditEvent.js';
import GitHubInstallation from '../src/models/GitHubInstallation.js';
import ProjectRepository from '../src/models/ProjectRepository.js';
import ProjectAssignment from '../src/models/ProjectAssignment.js';
import GitHubSyncJob from '../src/models/GitHubSyncJob.js';
import Source from '../src/models/Source.js';
import SourceRevision from '../src/models/SourceRevision.js';
import { GITHUB_CONTENT_LIMITS } from '../src/services/githubContent.js';

const testUri = process.env.RELAY_TEST_MONGODB_URI;
const testOptions = testUri ? { skip: false } : { skip: 'Set RELAY_TEST_MONGODB_URI to the isolated local replica-set database.' };

async function assertSafeTestUri(uri) {
  let parsed;
  try { parsed = new URL(uri); } catch { throw new Error('RELAY_TEST_MONGODB_URI must be a valid local MongoDB URI.'); }
  if (parsed.protocol !== 'mongodb:' || parsed.hostname !== '127.0.0.1' || parsed.port !== '27018'
    || decodeURIComponent(parsed.pathname.replace(/^\//, '')) !== 'relay_round3_test'
    || parsed.searchParams.get('replicaSet') !== 'rs0') {
    throw new Error('GitHub sync integration tests only permit the isolated 127.0.0.1:27018/relay_round3_test replica set.');
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 3000 });
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  assert.equal(hello.setName, 'rs0');
  assert.equal(hello.isWritablePrimary, true);
}

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const issue = (number, body = `Body for issue ${number}`, updatedAt = '2026-11-17T12:00:00Z', extra = {}) => ({
  id: number + 10000, number, title: `Issue ${number}`, body, state: number % 2 ? 'open' : 'closed', updated_at: updatedAt, ...extra,
});
const commit = (sha, message) => ({ sha, commit: { message, author: { date: '2026-11-17T11:00:00Z' } } });

test('GitHub synchronization persists immutable revisions and recovers safely (isolated replica set only)', testOptions, async (t) => {
  await assertSafeTestUri(testUri);
  const previousEnv = Object.fromEntries([
    'MONGODB_URI', 'JWT_SECRET', 'AUDIT_RETENTION_DAYS', 'GITHUB_APP_ID', 'GITHUB_APP_SLUG',
    'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET',
    'GITHUB_APP_SETUP_URL', 'GITHUB_APP_OAUTH_CALLBACK_URL',
  ].map((key) => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  const owned = { users: [], projectIds: [], linkIds: [], installationIds: [], jobIds: [] };
  let server;
  let app;
  let nextRepositoryId = 8100;
  let behavior = {};
  const providerCounters = { installationStatus: 0 };
  const providerPaths = [];
  let providerPause;
  let pauseEntered;
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const testPrivateKey = privateKey.export({ type: 'pkcs8', format: 'pem' });

  try {
    process.env.MONGODB_URI = testUri;
    process.env.JWT_SECRET = 'phase4c-local-test-jwt-signing-key-for-integration';
    process.env.AUDIT_RETENTION_DAYS = '365';
    process.env.GITHUB_APP_ID = '8100';
    process.env.GITHUB_APP_SLUG = 'relay-phase4c-test';
    process.env.GITHUB_APP_PRIVATE_KEY = testPrivateKey;
    process.env.GITHUB_APP_CLIENT_ID = 'phase4c-test-client';
    process.env.GITHUB_APP_CLIENT_SECRET = 'phase4c-test-secret';
    process.env.GITHUB_APP_SETUP_URL = 'http://127.0.0.1:5001/api/integrations/github/setup';
    process.env.GITHUB_APP_OAUTH_CALLBACK_URL = 'http://127.0.0.1:5001/api/integrations/github/oauth/callback';

    const [{ default: importedApp }] = await Promise.all([import('../src/app.js')]);
    app = importedApp;
    await Promise.all([
      User.init(), Project.init(), AuditEvent.init(), GitHubInstallation.init(), ProjectRepository.init(),
      ProjectAssignment.init(), GitHubSyncJob.init(), Source.init(), SourceRevision.init(),
    ]);

    globalThis.fetch = async (input, options = {}) => {
      const url = new URL(String(input));
      if (url.hostname === 'github.com') return json({ access_token: 'test-user-token' });
      if (url.hostname !== 'api.github.com') return previousFetch(input, options);
      providerPaths.push(url.pathname);

      if (providerPause && providerPause.path === url.pathname && !providerPause.entered) {
        providerPause.entered = true;
        providerPause.enter();
        await providerPause.wait;
      }
      if (url.pathname.endsWith('/access_tokens')) return json({
        token: 'test-installation-token', expires_at: new Date(Date.now() + 3600000).toISOString(),
        permissions: { contents: 'read', issues: 'read' },
      }, 201);
      const repoId = url.pathname.match(/^\/repositories\/(\d+)$/)?.[1];
      if (repoId) {
        if (behavior.inaccessibleRepository === repoId) return json({ message: 'private provider payload' }, 404);
        if (behavior.expireBeforeContent === repoId) {
          behavior.expireBeforeContent = null;
          const targetLink = await ProjectRepository.findOne({ repositoryId: repoId });
          const activeJob = await GitHubSyncJob.findOne({ repositoryLink: targetLink?._id, active: true });
          assert.ok(activeJob);
          await GitHubSyncJob.updateOne({ _id: activeJob._id }, { $set: { deadlineAt: new Date(Date.now() + 4000) } });
        }
        return json({ id: Number(repoId), owner: { login: 'phase4c-org' }, name: `repo-${repoId}`, default_branch: 'main' });
      }
      const installId = url.pathname.match(/^\/app\/installations\/(\d+)$/)?.[1];
      if (installId) {
        providerCounters.installationStatus += 1;
        if (behavior.removedInstallation === installId) return json({}, 404);
        const suspended = behavior.suspendedInstallation === installId;
        return json({
          id: Number(installId), account: { id: Number(installId) + 1, login: 'phase4c-org', type: 'Organization' },
          permissions: { contents: 'read', issues: 'read' }, suspended_at: suspended ? '2026-11-17T00:00:00Z' : null,
        });
      }
      if (/^\/repos\/phase4c-org\/repo-\d+\/readme$/.test(url.pathname)) {
        if (behavior.missingReadme === url.pathname.split('/')[3].replace('repo-', '')) return json({ message: 'README missing' }, 404);
        const text = behavior.readmeText || '# RELAY README\nCaptured from GitHub.\n';
        return json({ name: 'README.md', path: 'README.md', sha: 'a'.repeat(40), encoding: 'base64', size: Buffer.byteLength(text), content: Buffer.from(text).toString('base64') });
      }
      if (/^\/repos\/phase4c-org\/repo-\d+\/commits$/.test(url.pathname)) {
        return json([
          commit('b'.repeat(40), 'Commit one'),
          commit('c'.repeat(40), 'Commit two'),
        ]);
      }
      if (/^\/repos\/phase4c-org\/repo-\d+\/issues$/.test(url.pathname)) {
        const page = Number(url.searchParams.get('page'));
        if (behavior.failIssuePageOnce === page) {
          behavior.failIssuePageOnce = null;
          return json({ message: 'provider secret must not persist' }, 503);
        }
        if (behavior.issueMode === 'paged') {
          if (page === 1) return json([
            ...Array.from({ length: 80 }, (_, index) => issue(100 + index)),
            ...Array.from({ length: 20 }, (_, index) => issue(1000 + index, 'pull request', undefined, { pull_request: { url: 'private' } })),
          ]);
          if (page === 2) return json([issue(500), issue(501)]);
        }
        const version = behavior.issueVersion || 0;
        return json([issue(1, `First body ${version}`, version ? '2026-11-18T12:00:00Z' : '2026-11-17T12:00:00Z'),
          issue(2, 'Second body'), issue(3, 'PR', undefined, { pull_request: { url: 'private provider URL' } })]);
      }
      return json({ message: 'unexpected provider endpoint' }, 500);
    };

    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const createUser = async (role) => {
      const user = await User.create({ name: `Phase 4C ${role}`, email: `phase4c-${role}-${new mongoose.Types.ObjectId()}@example.test`, passwordHash: 'test-only-hash' });
      owned.users.push(user._id);
      return user;
    };
    const owner = await createUser('owner');
    const editor = await createUser('editor');
    const viewer = await createUser('viewer');
    const successor = await createUser('successor');
    const outsider = await createUser('outsider');
    const tokens = Object.fromEntries(Object.entries({ owner, editor, viewer, successor, outsider }).map(([role, user]) => [
      role, jwt.sign({ sub: String(user._id) }, process.env.JWT_SECRET, { expiresIn: '10m' }),
    ]));
    const api = async (role, route, { method = 'GET', body } = {}) => {
      const response = await previousFetch(`${baseUrl}${route}`, {
        method,
        headers: { authorization: `Bearer ${tokens[role]}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      let data;
      try { data = await response.json(); } catch { data = {}; }
      return { status: response.status, data };
    };
    const fixture = async (name) => {
      behavior = {};
      const project = await Project.create({ name, owner: owner._id, members: [
        { user: owner._id, role: 'owner' }, { user: editor._id, role: 'editor' }, { user: viewer._id, role: 'viewer' },
      ] });
      owned.projectIds.push(project._id);
      await ProjectAssignment.create({ project: project._id, user: viewer._id, role: 'reviewer', scopeType: 'project', assignedBy: owner._id });
      await ProjectAssignment.create({ project: project._id, user: editor._id, role: 'approver', scopeType: 'project', assignedBy: owner._id });
      const installId = String(8200 + owned.projectIds.length);
      const installation = await GitHubInstallation.create({
        installationId: installId, accountId: '8201', accountLogin: 'phase4c-org', accountType: 'Organization',
        installedBy: owner._id, authorizedUsers: [owner._id], status: 'active',
        grantedPermissions: { contents: 'read', issues: 'read' }, lastVerifiedAt: new Date(),
      });
      owned.installationIds.push(installation._id);
      const repositoryId = String(nextRepositoryId++);
      const link = await ProjectRepository.create({
        project: project._id, installation: installation._id, repositoryId,
        ownerLogin: 'phase4c-org', name: `repo-${repositoryId}`, fullName: `phase4c-org/repo-${repositoryId}`,
        htmlUrl: `https://github.com/phase4c-org/repo-${repositoryId}`, defaultBranch: 'main', linkedBy: owner._id,
      });
      owned.linkIds.push(link._id);
      return { project, installation, link, repositoryId };
    };
    const syncPath = (f) => `/projects/${f.project._id}/github/repositories/${f.link._id}/sync`;
    const statusPath = (f, jobId) => `/projects/${f.project._id}/github/sync-jobs/${jobId}`;
    const retryPath = (f, jobId) => `/projects/${f.project._id}/github/sync-jobs/${jobId}/retry`;

    await t.test('owner-only sync ingests README, commits, issues and immutable provenance; retries reuse prior records', async () => {
      const f = await fixture('Phase 4C success');
      assert.equal((await api('editor', syncPath(f), { method: 'POST', body: { repositoryId: '999' } })).status, 403);
      assert.equal((await api('viewer', syncPath(f), { method: 'POST' })).status, 403);
      assert.equal((await api('outsider', syncPath(f), { method: 'POST' })).status, 403);
      const first = await api('owner', syncPath(f), { method: 'POST' });
      assert.equal(first.status, 201);
      assert.equal(first.data.job.status, 'completed', `sync status code: ${first.data.job.lastErrorCode || 'none'}`);
      assert.equal(first.data.job.checkpoints.readme.status, 'completed');
      assert.equal(first.data.job.checkpoints.commits.status, 'completed');
      assert.equal(first.data.job.checkpoints.issues.status, 'completed');
      assert.equal(first.data.job.counts.commitsCaptured, 2);
      assert.equal(first.data.job.counts.issuesCaptured, 2);
      assert.ok(first.data.job.counts.contentBytes <= GITHUB_CONTENT_LIMITS.total);
      owned.jobIds.push(first.data.job.id);

      const sources = await Source.find({ project: f.project._id, provider: 'github', repositoryLink: f.link._id });
      assert.equal(sources.length, 5);
      assert.ok(sources.every((source) => source.currentRevision && source.status === 'processed'));
      const revisions = await SourceRevision.find({ source: { $in: sources.map((source) => source._id) } });
      assert.equal(revisions.length, 5);
      assert.equal(first.data.job.counts.contentBytes, revisions.reduce((sum, revision) => sum + revision.locator.contentBytes, 0));
      const firstIssue = sources.find((source) => source.externalType === 'issue' && source.externalId === '1');
      const previousRevisionId = firstIssue.currentRevision;

      assert.equal((await api('viewer', statusPath(f, first.data.job.id))).status, 200);
      assert.equal((await api('outsider', statusPath(f, first.data.job.id))).status, 403);
      const content = await api('viewer', `/sources/${firstIssue._id}/content`);
      assert.equal(content.status, 200);
      assert.equal(content.data.source.extractedText, 'Issue 1\n\nFirst body 0');
      const revisionHistory = await api('viewer', `/sources/${firstIssue._id}/revisions`);
      assert.equal(revisionHistory.status, 200);
      assert.equal(revisionHistory.data.total, 1);
      assert.equal(revisionHistory.data.revisions[0].isCurrent, true);
      assert.equal(revisionHistory.data.revisions[0].locator.issueNumber, 1);
      assert.equal(Object.hasOwn(revisionHistory.data.revisions[0], 'textSnapshot'), false);
      assert.equal((await api('outsider', `/sources/${firstIssue._id}/revisions`)).status, 403);
      const linkedView = await api('viewer', `/projects/${f.project._id}/github/repositories`);
      assert.equal(linkedView.status, 200);
      assert.equal(linkedView.data.repositories[0].status, 'active');
      assert.equal(linkedView.data.repositories[0].connectionStatus, 'active');
      assert.equal(linkedView.data.repositories[0].latestSyncJob.status, 'completed');
      assert.equal(Object.hasOwn(linkedView.data.repositories[0].latestSyncJob, 'leaseToken'), false);
      const download = await previousFetch(`${baseUrl}/sources/${firstIssue._id}/download`, { headers: { authorization: `Bearer ${tokens.viewer}` } });
      assert.equal(download.status, 200);
      assert.equal(await download.text(), 'Issue 1\n\nFirst body 0');
      const protectedDelete = await api('owner', `/sources/${firstIssue._id}`, { method: 'DELETE' });
      assert.equal(protectedDelete.status, 409);

      const repeated = await api('owner', syncPath(f), { method: 'POST' });
      assert.equal(repeated.status, 201);
      owned.jobIds.push(repeated.data.job.id);
      assert.equal(await Source.countDocuments({ project: f.project._id, provider: 'github', repositoryLink: f.link._id }), 5);
      assert.equal(await SourceRevision.countDocuments({ source: { $in: sources.map((source) => source._id) } }), 5);
      assert.equal(repeated.data.job.counts.revisionsReused, 1, 'the unchanged README revision is reused');

      behavior.issueVersion = 1;
      const updated = await api('owner', syncPath(f), { method: 'POST' });
      assert.equal(updated.data.job.status, 'completed');
      owned.jobIds.push(updated.data.job.id);
      await firstIssue.populate('currentRevision');
      const refreshedIssue = await Source.findById(firstIssue._id).populate('currentRevision');
      assert.notEqual(String(refreshedIssue.currentRevision._id), String(previousRevisionId));
      assert.equal(await SourceRevision.countDocuments({ source: firstIssue._id }), 2);
      assert.equal((await SourceRevision.findById(previousRevisionId)).textSnapshot, 'Issue 1\n\nFirst body 0');
      const pinnedContent = await api('viewer', `/sources/${firstIssue._id}/content?revisionId=${previousRevisionId}`);
      assert.equal(pinnedContent.status, 200);
      assert.equal(pinnedContent.data.source.extractedText, 'Issue 1\n\nFirst body 0');
      assert.equal(String(pinnedContent.data.source.revisionId), String(previousRevisionId));
      const wrongSourceRevision = await SourceRevision.findOne({ source: { $ne: firstIssue._id } }).select('_id').lean();
      assert.ok(wrongSourceRevision);
      assert.equal((await api('viewer', `/sources/${firstIssue._id}/content?revisionId=${wrongSourceRevision._id}`)).status, 404);

      assert.equal((await api('viewer', `/projects/${f.project._id}/github/repositories/${f.link._id}`, { method: 'DELETE' })).status, 403);
      assert.equal((await api('owner', `/projects/${f.project._id}/github/repositories/${f.link._id}`, { method: 'DELETE' })).status, 200);
      const unlinkedView = await api('viewer', `/projects/${f.project._id}/github/repositories`);
      assert.equal(unlinkedView.data.repositories[0].connectionStatus, 'unlinked');
      assert.equal(unlinkedView.data.repositories[0].status, 'unlinked');

      const events = await AuditEvent.find({ projectId: f.project._id }).lean();
      assert.equal(events.filter((event) => event.action === 'github.sync.started').length, 3);
      assert.equal(events.filter((event) => event.action === 'github.sync.completed').length, 3);
      const auditText = JSON.stringify(events);
      assert.equal(auditText.includes('test-installation-token'), false);
      assert.equal(auditText.includes('First body'), false);
      const responseText = JSON.stringify([first.data, repeated.data, updated.data]);
      assert.equal(responseText.includes('test-installation-token'), false);
      const persistedAuthAndJobs = JSON.stringify([
        await GitHubInstallation.findById(f.installation._id).lean(),
        ...await GitHubSyncJob.find({ project: f.project._id }).lean(),
      ]);
      assert.equal(persistedAuthAndJobs.includes('test-installation-token'), false);

      const anotherProject = await fixture('Phase 4C project scope');
      assert.equal((await api('owner', statusPath(anotherProject, first.data.job.id))).status, 404);
      const crossedLink = await api('owner', syncPath({ ...anotherProject, link: f.link }), { method: 'POST' });
      assert.equal(crossedLink.status, 409);
    });

    await t.test('missing README is recorded as skipped only after repository access succeeds', async () => {
      const f = await fixture('Phase 4C no README');
      const startAt = providerPaths.length;
      behavior.missingReadme = f.repositoryId;
      const result = await api('owner', syncPath(f), { method: 'POST' });
      assert.equal(result.data.job.status, 'completed');
      assert.equal(result.data.job.checkpoints.readme.status, 'skipped');
      const paths = providerPaths.slice(startAt);
      const accessIndex = paths.indexOf(`/repositories/${f.repositoryId}`);
      const readmeIndex = paths.findIndex((path) => path.endsWith('/readme'));
      assert.ok(accessIndex >= 0 && readmeIndex > accessIndex);
      assert.equal(await Source.countDocuments({ project: f.project._id, externalType: 'readme' }), 0);
      assert.equal(await Source.countDocuments({ project: f.project._id, externalType: 'commit' }), 2);
      owned.jobIds.push(result.data.job.id);
    });

    await t.test('partial page failure checkpoints completed records and explicit retry resumes without duplicates', async () => {
      const f = await fixture('Phase 4C retry');
      behavior = { issueMode: 'paged', failIssuePageOnce: 2 };
      const started = await api('owner', syncPath(f), { method: 'POST' });
      assert.ok([200, 201].includes(started.status));
      assert.equal(started.data.job.status, 'retry_wait', `sync status code: ${started.data.job.lastErrorCode || 'none'}`);
      assert.equal(started.data.job.lastErrorCode, 'GITHUB_PROVIDER_ERROR');
      assert.equal(started.data.job.checkpoints.readme.status, 'completed');
      assert.equal(started.data.job.checkpoints.commits.status, 'completed');
      assert.equal(started.data.job.checkpoints.issues.page, 1);
      assert.equal(started.data.job.checkpoints.issues.rawEntriesScanned, 100);
      assert.equal(started.data.job.counts.issuesCaptured, 80);
      assert.equal(started.data.job.counts.pullRequestsSkipped, 20);
      owned.jobIds.push(started.data.job.id);
      assert.equal(await Source.countDocuments({ project: f.project._id, externalType: 'issue' }), 80);
      const retryEvents = await AuditEvent.find({ projectId: f.project._id }).lean();
      assert.equal(JSON.stringify(retryEvents).includes('provider secret'), false);

      await new Promise((resolve) => setTimeout(resolve, 1100));
      const resumed = await api('owner', retryPath(f, started.data.job.id), { method: 'POST' });
      assert.equal(resumed.status, 200);
      assert.equal(resumed.data.job.status, 'completed');
      assert.equal(resumed.data.job.attemptCount, 2);
      assert.equal(resumed.data.job.checkpoints.issues.page, 2);
      assert.equal(resumed.data.job.checkpoints.issues.rawEntriesScanned, 102);
      assert.equal(await Source.countDocuments({ project: f.project._id, externalType: 'issue' }), 82);
      assert.equal(await SourceRevision.countDocuments({ source: { $in: await Source.find({ project: f.project._id }).distinct('_id') } }), 85);
      assert.equal((await api('viewer', retryPath(f, started.data.job.id), { method: 'POST' })).status, 403);
      assert.equal((await api('editor', retryPath(f, started.data.job.id), { method: 'POST' })).status, 403);
    });

    await t.test('concurrent start requests share one active lease and only one provider workflow runs', async () => {
      const f = await fixture('Phase 4C concurrency');
      const providerStart = providerPaths.length;
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      let entered;
      const atProvider = new Promise((resolve) => { entered = resolve; });
      providerPause = { path: `/repos/phase4c-org/repo-${f.repositoryId}/readme`, wait: gate, enter: entered, entered: false };
      const firstRequest = api('owner', syncPath(f), { method: 'POST' });
      await atProvider;
      const second = await api('owner', syncPath(f), { method: 'POST' });
      assert.equal(second.status, 202);
      assert.equal(second.data.job.status, 'running');
      owned.jobIds.push(second.data.job.id);
      release();
      providerPause = null;
      const first = await firstRequest;
      assert.equal(first.data.job.id, second.data.job.id);
      assert.equal(first.data.job.status, 'completed');
      assert.equal(await GitHubSyncJob.countDocuments({ repositoryLink: f.link._id, active: true }), 0);
      assert.equal(await Source.countDocuments({ project: f.project._id, provider: 'github' }), 5);
      assert.equal(providerPaths.slice(providerStart).filter((path) => path.endsWith('/readme')).length, 1);
    });

    await t.test('client disconnect leaves the persisted sync running to a durable terminal state', async () => {
      const f = await fixture('Phase 4C disconnect');
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      let entered;
      const atProvider = new Promise((resolve) => { entered = resolve; });
      providerPause = { path: `/repos/phase4c-org/repo-${f.repositoryId}/readme`, wait: gate, enter: entered, entered: false };
      const controller = new AbortController();
      const pending = previousFetch(`${baseUrl}${syncPath(f)}`, {
        method: 'POST', headers: { authorization: `Bearer ${tokens.owner}` }, signal: controller.signal,
      }).catch((error) => error);
      await atProvider;
      const job = await GitHubSyncJob.findOne({ project: f.project._id, repositoryLink: f.link._id, active: true });
      assert.ok(job);
      owned.jobIds.push(job._id);
      controller.abort();
      release();
      providerPause = null;
      await pending;
      let status;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        status = await api('viewer', statusPath(f, job._id));
        if (status.data?.job?.status === 'completed' || status.data?.job?.status === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(status.data.job.status, 'completed');
      assert.equal(await Source.countDocuments({ project: f.project._id, provider: 'github' }), 5);
    });

    await t.test('deadline reserve stops new provider requests before content persistence cannot finish safely', async () => {
      const f = await fixture('Phase 4C deadline');
      const firstContentRequestIndex = providerPaths.length;
      behavior.expireBeforeContent = f.repositoryId;
      const result = await api('owner', syncPath(f), { method: 'POST' });
      assert.equal(result.data.job.status, 'partial');
      assert.equal(result.data.job.lastErrorCode, 'GITHUB_SYNC_DEADLINE');
      assert.equal(result.data.job.retryable, true);
      assert.equal(providerPaths.slice(firstContentRequestIndex).some((path) => path.endsWith('/readme')), false);
      assert.equal(await Source.countDocuments({ project: f.project._id, provider: 'github' }), 0);
      owned.jobIds.push(result.data.job.id);
    });

    await t.test('ownership transfer or unlink during provider fetch prevents that batch from persisting', async () => {
      for (const operation of ['transfer', 'unlink']) {
        const f = await fixture(`Phase 4C ${operation}`);
        const requestStart = providerPaths.length;
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        let entered;
        const atProvider = new Promise((resolve) => { entered = resolve; });
        providerPause = { path: `/repos/phase4c-org/repo-${f.repositoryId}/readme`, wait: gate, enter: entered, entered: false };
        const pending = api('owner', syncPath(f), { method: 'POST' });
        await atProvider;
        if (operation === 'transfer') await Project.updateOne({ _id: f.project._id }, { $set: { owner: successor._id } });
        else await ProjectRepository.updateOne({ _id: f.link._id }, { $set: { status: 'unlinked', unlinkedAt: new Date(), unlinkedBy: owner._id } });
        release();
        providerPause = null;
        const response = await pending;
        assert.equal(response.data.job.status, 'failed');
        assert.equal(await Source.countDocuments({ project: f.project._id, provider: 'github' }), 0);
        assert.ok(['PROJECT_OWNER_CHANGED', 'GITHUB_REPOSITORY_UNLINKED'].includes(response.data.job.lastErrorCode));
        assert.equal(providerPaths.slice(requestStart).some((path) => path.endsWith('/commits') || path.endsWith('/issues')), false);
        owned.jobIds.push(response.data.job.id);
      }
    });

    await t.test('inaccessible and stale suspended installations fail safely; expired lease is owner-recoverable', async () => {
      const inaccessible = await fixture('Phase 4C inaccessible');
      behavior.inaccessibleRepository = inaccessible.repositoryId;
      const denied = await api('owner', syncPath(inaccessible), { method: 'POST' });
      assert.equal(denied.data.job.status, 'failed');
      assert.equal(denied.data.job.lastErrorCode, 'GITHUB_REPOSITORY_ACCESS_UNAVAILABLE');
      assert.equal(await Source.countDocuments({ project: inaccessible.project._id }), 0);
      owned.jobIds.push(denied.data.job.id);

      behavior.inaccessibleRepository = null;
      const refreshed = await fixture('Phase 4C stale active install');
      await GitHubInstallation.updateOne({ _id: refreshed.installation._id }, { $set: { lastVerifiedAt: new Date(Date.now() - 10 * 60 * 1000) } });
      const beforeRefresh = providerCounters.installationStatus;
      const refreshedResult = await api('owner', syncPath(refreshed), { method: 'POST' });
      assert.equal(refreshedResult.data.job.status, 'completed');
      assert.ok(providerCounters.installationStatus > beforeRefresh, 'stale installation status is refreshed before import');
      owned.jobIds.push(refreshedResult.data.job.id);

      const suspended = await fixture('Phase 4C suspended');
      await GitHubInstallation.updateOne({ _id: suspended.installation._id }, { $set: { lastVerifiedAt: new Date(Date.now() - 10 * 60 * 1000) } });
      behavior.suspendedInstallation = suspended.installation.installationId;
      const suspendedResult = await api('owner', syncPath(suspended), { method: 'POST' });
      assert.equal(suspendedResult.data.job.status, 'failed');
      assert.equal(suspendedResult.data.job.lastErrorCode, 'GITHUB_INSTALLATION_SUSPENDED');
      assert.equal((await GitHubInstallation.findById(suspended.installation._id)).status, 'suspended');
      owned.jobIds.push(suspendedResult.data.job.id);

      behavior.suspendedInstallation = null;
      const removed = await fixture('Phase 4C removed');
      await GitHubInstallation.updateOne({ _id: removed.installation._id }, { $set: { lastVerifiedAt: new Date(Date.now() - 10 * 60 * 1000) } });
      behavior.removedInstallation = removed.installation.installationId;
      const removedResult = await api('owner', syncPath(removed), { method: 'POST' });
      assert.equal(removedResult.data.job.status, 'failed');
      assert.equal(removedResult.data.job.lastErrorCode, 'GITHUB_INSTALLATION_REMOVED');
      assert.equal((await GitHubInstallation.findById(removed.installation._id)).status, 'removed');
      owned.jobIds.push(removedResult.data.job.id);

      behavior.removedInstallation = null;
      const abandoned = await fixture('Phase 4C abandoned');
      const old = new Date(Date.now() - 120_000);
      const job = await GitHubSyncJob.create({
        project: abandoned.project._id, repositoryLink: abandoned.link._id, installation: abandoned.installation._id,
        requestedBy: owner._id, status: 'running', active: true, retryable: false,
        attemptCount: 1, startedAt: old, deadlineAt: old, leaseToken: 'expired-lease', leaseExpiresAt: old,
      });
      owned.jobIds.push(job._id);
      assert.equal((await api('viewer', statusPath(abandoned, job._id))).data.job.status, 'interrupted');
      const recovered = await api('owner', retryPath(abandoned, job._id), { method: 'POST' });
      assert.equal(recovered.status, 200);
      assert.equal(recovered.data.job.status, 'completed');
      assert.equal(recovered.data.job.attemptCount, 2);
    });
  } finally {
    providerPause?.release?.();
    if (server) await new Promise((resolve) => server.close(resolve));
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (mongoose.connection.readyState === 1) {
      const sourceRecords = await Source.find({ project: { $in: owned.projectIds } }).select('_id').lean();
      const sourceIds = sourceRecords.map((source) => source._id);
      if (owned.jobIds.length) await GitHubSyncJob.deleteMany({ _id: { $in: owned.jobIds } });
      if (sourceIds.length) await SourceRevision.deleteMany({ source: { $in: sourceIds } });
      if (owned.projectIds.length) {
        await Source.deleteMany({ project: { $in: owned.projectIds } });
        await AuditEvent.deleteMany({ projectId: { $in: owned.projectIds } });
        await ProjectAssignment.deleteMany({ project: { $in: owned.projectIds } });
        await ProjectRepository.deleteMany({ project: { $in: owned.projectIds } });
        await GitHubSyncJob.deleteMany({ project: { $in: owned.projectIds } });
        await Project.deleteMany({ _id: { $in: owned.projectIds } });
      }
      if (owned.installationIds.length) await GitHubInstallation.deleteMany({ _id: { $in: owned.installationIds } });
      if (owned.users.length) await User.deleteMany({ _id: { $in: owned.users } });
      await mongoose.disconnect();
    }
  }
});
