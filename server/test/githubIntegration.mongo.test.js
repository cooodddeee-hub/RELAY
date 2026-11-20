import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { lookup } from 'node:dns/promises';
import { isIPv4, isIPv6 } from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import User from '../src/models/User.js';
import Project from '../src/models/Project.js';
import AuditEvent from '../src/models/AuditEvent.js';
import GitHubInstallation from '../src/models/GitHubInstallation.js';
import GitHubInstallState from '../src/models/GitHubInstallState.js';
import ProjectRepository from '../src/models/ProjectRepository.js';
import ProjectAssignment from '../src/models/ProjectAssignment.js';
import Source from '../src/models/Source.js';
import SourceRevision from '../src/models/SourceRevision.js';
import { hashInstallState } from '../src/services/githubApp.js';

const testUri = process.env.RELAY_TEST_MONGODB_URI;
const testOptions = testUri ? { skip: false } : { skip: 'Set RELAY_TEST_MONGODB_URI to an isolated local replica-set database.' };

async function assertSafeTestUri(uri) {
  let parsed;
  try { parsed = new URL(uri); } catch { throw new Error('RELAY_TEST_MONGODB_URI must be a valid local mongodb:// URI.'); }
  if (parsed.protocol !== 'mongodb:' || !['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname)) throw new Error('GitHub integration tests refuse non-local MongoDB hosts.');
  const addresses = await lookup(parsed.hostname.replace(/^\[|\]$/g, ''), { all: true });
  if (!addresses.length || !addresses.every(({ address }) => (isIPv4(address) && address.startsWith('127.')) || (isIPv6(address) && address === '::1'))) throw new Error('GitHub integration tests require loopback-only MongoDB.');
  if (decodeURIComponent(parsed.pathname.replace(/^\//, '')) !== 'relay_round3_test') throw new Error('GitHub integration tests require the relay_round3_test database.');
}

test('GitHub App authorization and repository linking integration (mock provider, local replica set only)', testOptions, async (t) => {
  await assertSafeTestUri(testUri);
  const previousEnv = Object.fromEntries(['MONGODB_URI', 'JWT_SECRET', 'AUDIT_RETENTION_DAYS', 'GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET', 'GITHUB_APP_SETUP_URL', 'GITHUB_APP_OAUTH_CALLBACK_URL'].map((key) => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  const projectIds = [];
  const userIds = [];
  const sourceIds = [];
  const revisionIds = [];
  let server;
  let providerHook;
  let installationMode = 'active';
  let oauthCanAccess = true;
  let oauthInstallationIds = ['42', '44'];
  let revokedUserTokens = 0;
  const oauthProviderSequence = [];
  let repositoryOwner = 'round3-org';
  let repositoryName = 'relay-private';
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const testPrivateKey = privateKey.export({ type: 'pkcs8', format: 'pem' });
  try {
    process.env.MONGODB_URI = testUri;
    process.env.JWT_SECRET = 'local-github-integration-test-signing-key-longer';
    process.env.AUDIT_RETENTION_DAYS = '365';
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_SLUG = 'relay-test-app';
    process.env.GITHUB_APP_PRIVATE_KEY = testPrivateKey;
    process.env.GITHUB_APP_CLIENT_ID = 'test-client-id';
    process.env.GITHUB_APP_CLIENT_SECRET = 'test-client-secret';
    process.env.GITHUB_APP_SETUP_URL = 'http://127.0.0.1:5001/api/integrations/github/setup';
    process.env.GITHUB_APP_OAUTH_CALLBACK_URL = 'http://127.0.0.1:5001/api/integrations/github/oauth/callback';

    globalThis.fetch = async (url, options = {}) => {
      const parsed = new URL(url);
      if (providerHook && parsed.hostname === 'api.github.com') await providerHook(parsed, options);
      if (parsed.hostname === 'github.com' && parsed.pathname === '/login/oauth/access_token') return new Response(JSON.stringify({ access_token: 'ephemeral-user-test-token' }), { status: 200 });
      if (parsed.hostname !== 'api.github.com') return previousFetch(url, options);
      if (/^\/app\/installations\/(42|43|44)$/.test(parsed.pathname) && options.method !== 'POST') {
        oauthProviderSequence.push('app-installation-verification');
        if (installationMode === 'removed') return new Response('{}', { status: 404 });
        const installationId = Number(parsed.pathname.split('/').at(-1));
        return new Response(JSON.stringify({
          id: installationId, account: { id: 77, login: 'round3-org', type: 'Organization' },
          permissions: { contents: 'read', issues: 'read' }, suspended_at: installationMode === 'suspended' ? '2026-11-17T00:00:00Z' : null,
        }), { status: 200 });
      }
      if (parsed.pathname === '/app/installations/42/access_tokens') return new Response(JSON.stringify({ token: 'ephemeral-test-installation-token', expires_at: new Date(Date.now() + 3600000).toISOString(), permissions: { contents: 'read', issues: 'read' } }), { status: 201 });
      if (parsed.pathname === '/installation/repositories') return new Response(JSON.stringify({ repositories: [{ id: 9001, owner: { login: repositoryOwner }, name: repositoryName, full_name: `${repositoryOwner}/${repositoryName}`, html_url: `https://github.com/${repositoryOwner}/${repositoryName}`, default_branch: 'main', private: true }] }), { status: 200 });
      if (parsed.pathname === '/repositories/9001') return new Response(JSON.stringify({ id: 9001, owner: { login: repositoryOwner }, name: repositoryName, full_name: `${repositoryOwner}/${repositoryName}`, html_url: `https://github.com/${repositoryOwner}/${repositoryName}`, default_branch: 'main', private: true }), { status: 200 });
      if (parsed.pathname === '/repositories/9002') return new Response('{}', { status: 404 });
      if (parsed.pathname === '/repositories/9003') return new Response('{}', { status: 404 });
      if (parsed.pathname === '/repositories/9004') return new Response(JSON.stringify({ id: 9004, owner: { login: repositoryOwner }, name: 'race-check', full_name: `${repositoryOwner}/race-check`, html_url: `https://github.com/${repositoryOwner}/race-check`, default_branch: 'main', private: true }), { status: 200 });
      if (parsed.pathname === '/user') { oauthProviderSequence.push('user-identity'); return new Response(JSON.stringify({ id: 812, login: 'relay-github-owner' }), { status: 200 }); }
      if (parsed.pathname === '/user/installations') { oauthProviderSequence.push('user-installations'); return new Response(JSON.stringify({ installations: oauthCanAccess ? oauthInstallationIds.map((id) => ({ id: Number(id) })) : [] }), { status: 200 }); }
      if (parsed.pathname === '/applications/test-client-id/token' && options.method === 'DELETE') { oauthProviderSequence.push('user-token-revocation'); revokedUserTokens += 1; return new Response(null, { status: 204 }); }
      return new Response('{}', { status: 500 });
    };

    const [{ default: app }] = await Promise.all([import('../src/app.js')]);
    await mongoose.connect(testUri, { serverSelectionTimeoutMS: 3000 });
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    assert.ok(hello.setName, 'MongoDB must be a replica set.');
    assert.ok(hello.isWritablePrimary, 'MongoDB replica set needs a primary.');
    const repositoryIndexes = await mongoose.connection.collection('projectrepositories').indexes().catch(() => []);
    for (const index of repositoryIndexes) {
      const keys = Object.keys(index.key || {});
      if (index.unique && keys.length === 2 && keys.includes('project') && keys.includes('repositoryId')) {
        await mongoose.connection.collection('projectrepositories').dropIndex(index.name);
      }
    }
    await Promise.all([User.init(), Project.init(), AuditEvent.init(), GitHubInstallation.init(), GitHubInstallState.init(), ProjectRepository.init(), ProjectAssignment.init(), Source.init(), SourceRevision.init()]);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const users = {};
    for (const role of ['owner', 'editor', 'viewer', 'otherOwner']) {
      users[role] = await User.create({ name: `GitHub ${role}`, email: `gh-${role}-${new mongoose.Types.ObjectId()}@example.test`, passwordHash: 'local-test-hash' });
      userIds.push(users[role]._id);
    }
    const tokens = Object.fromEntries(Object.entries(users).map(([role, user]) => [role, jwt.sign({ sub: String(user._id) }, process.env.JWT_SECRET, { expiresIn: '10m' })]));
    const api = async (role, path, options = {}) => {
      const response = await fetch(`${baseUrl}${path}`, { ...options, headers: { authorization: `Bearer ${tokens[role]}`, ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers } });
      const data = await response.json();
      return { status: response.status, data };
    };
    const startInstall = (role, projectId) => api(role, `/projects/${projectId}/github/installations/start`, { method: 'POST' });
    const completeInstall = async (role, projectId, setupAction = 'install', code = 'valid-one-time-code', installationId = '42') => {
      const started = await startInstall(role, projectId);
      if (started.status !== 201) return started;
      const setupState = new URL(started.data.installationUrl).searchParams.get('state');
      const setup = await fetch(`${baseUrl}/integrations/github/setup?installation_id=${installationId}&setup_action=${setupAction}&state=${encodeURIComponent(setupState)}`, { redirect: 'manual' });
      if (setup.status !== 302) return { status: setup.status, data: await setup.json() };
      const oauthState = new URL(setup.headers.get('location')).searchParams.get('state');
      const oauth = await fetch(`${baseUrl}/integrations/github/oauth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(oauthState)}`, { redirect: 'manual' });
      return { status: oauth.status, location: oauth.headers.get('location'), setupState, oauthState };
    };
    const project = await Project.create({ name: 'GitHub integration project', owner: users.owner._id, members: [{ user: users.owner._id, role: 'owner' }, { user: users.editor._id, role: 'editor' }, { user: users.viewer._id, role: 'viewer' }] });
    projectIds.push(project._id);
    await ProjectAssignment.create([
      { project: project._id, user: users.viewer._id, role: 'reviewer', scopeType: 'project', assignedBy: users.owner._id },
      { project: project._id, user: users.editor._id, role: 'approver', scopeType: 'project', assignedBy: users.owner._id },
    ]);
    const secondProject = await Project.create({ name: 'Second owner project', owner: users.otherOwner._id, members: [{ user: users.otherOwner._id, role: 'owner' }] });
    projectIds.push(secondProject._id);

    await t.test('owner-only initiation, state binding, and one-time callback authorization', async () => {
      assert.equal((await api('editor', `/projects/${project.id}/github/installations/start`, { method: 'POST' })).status, 403);
      assert.equal((await api('viewer', `/projects/${project.id}/github/installations/start`, { method: 'POST' })).status, 403);
      const started = await startInstall('owner', project.id);
      assert.equal(started.status, 201);
      const setupUrl = new URL(started.data.installationUrl);
      assert.equal(setupUrl.hostname, 'github.com');
      const state = setupUrl.searchParams.get('state');
      const firstStep = await fetch(`${baseUrl}/integrations/github/setup?installation_id=42&setup_action=install&state=${encodeURIComponent(state)}`, { redirect: 'manual' });
      assert.equal(firstStep.status, 302);
      const oauthState = new URL(firstStep.headers.get('location')).searchParams.get('state');
      const accepted = await fetch(`${baseUrl}/integrations/github/oauth/callback?code=valid-one-time-code&state=${encodeURIComponent(oauthState)}`, { redirect: 'manual' });
      assert.equal(accepted.status, 302);
      const oauthReplay = await fetch(`${baseUrl}/integrations/github/oauth/callback?code=valid-one-time-code&state=${encodeURIComponent(oauthState)}`);
      assert.equal(oauthReplay.status, 400);
      const callbackUrl = new URL(accepted.headers.get('location'));
      assert.equal(callbackUrl.searchParams.get('github'), 'authorized');
      assert.equal(callbackUrl.searchParams.get('projectId'), String(project._id));
      assert.equal(accepted.headers.get('location').includes('ephemeral-test-installation-token'), false);
      assert.equal(accepted.headers.get('location').includes('ephemeral-user-test-token'), false);
      const ownerInstallations = await api('owner', `/projects/${project.id}/github/installations`);
      assert.equal(ownerInstallations.status, 200);
      assert.equal(ownerInstallations.data.installations[0].status, 'active');
      assert.equal(ownerInstallations.data.installations[0].statusVerified, true);
      assert.equal((await api('editor', `/projects/${project.id}/github/installations`)).status, 403);
      assert.equal((await api('viewer', `/projects/${project.id}/github/installations`)).status, 403);
      for (const role of ['owner', 'editor', 'viewer']) {
        assert.equal((await api(role, `/projects/${project.id}/github/repositories`)).status, 200);
      }
      const replay = await fetch(`${baseUrl}/integrations/github/setup?installation_id=42&setup_action=install&state=${encodeURIComponent(state)}`);
      assert.equal(replay.status, 400);
      const configureStart = await startInstall('owner', project.id);
      const configureState = new URL(configureStart.data.installationUrl).searchParams.get('state');
      const unsupportedConfigure = await fetch(`${baseUrl}/integrations/github/setup?installation_id=42&setup_action=configure&state=${encodeURIComponent(configureState)}`);
      assert.equal(unsupportedConfigure.status, 400);
      assert.equal((await api('owner', `/projects/${secondProject.id}/github/repositories?installationId=42`)).status, 403);
      oauthCanAccess = false;
      const deniedInstallation = await completeInstall('otherOwner', secondProject.id, 'install', 'not-authorized-code', '43');
      assert.equal(deniedInstallation.status, 302);
      assert.equal(new URL(deniedInstallation.location).searchParams.get('github'), 'failed');
      assert.equal(await GitHubInstallation.countDocuments({ installationId: '43' }), 0);
      oauthCanAccess = true;
      const otherCallback = await completeInstall('otherOwner', secondProject.id);
      assert.equal(otherCallback.status, 302);
      assert.equal((await api('owner', `/projects/${project.id}/github/repositories?installationId=42`)).status, 200);
      assert.equal((await api('otherOwner', `/projects/${secondProject.id}/github/repositories?installationId=42`)).status, 200);
    });

    await t.test('OAuth-first authorization discovers an existing installation, stays owner-bound, and returns to its project', async () => {
      assert.equal((await api('editor', `/projects/${secondProject.id}/github/installations/authorize`, { method: 'POST' })).status, 403);
      assert.equal((await api('viewer', `/projects/${secondProject.id}/github/installations/authorize`, { method: 'POST' })).status, 403);
      assert.equal((await api('owner', `/projects/${secondProject.id}/github/installations/authorize`, { method: 'POST' })).status, 403);
      oauthInstallationIds = ['43'];
      const beforeRevocations = revokedUserTokens;
      const started = await api('otherOwner', `/projects/${secondProject.id}/github/installations/authorize`, { method: 'POST' });
      assert.equal(started.status, 201);
      const authUrl = new URL(started.data.authorizationUrl);
      assert.equal(authUrl.hostname, 'github.com');
      assert.equal(authUrl.pathname, '/login/oauth/authorize');
      const state = authUrl.searchParams.get('state');
      const pending = await GitHubInstallState.findOne({ stateHash: hashInstallState(state), purpose: 'oauth_discovery' });
      assert.ok(pending);
      assert.equal(String(pending.project), String(secondProject._id));
      assert.equal(String(pending.actor), String(users.otherOwner._id));
      assert.equal(pending.installationId, undefined);
      oauthProviderSequence.length = 0;
      const response = await fetch(`${baseUrl}/integrations/github/oauth/callback?code=existing-install-code&state=${encodeURIComponent(state)}`, { redirect: 'manual' });
      assert.equal(response.status, 302);
      const returned = new URL(response.headers.get('location'));
      assert.equal(returned.searchParams.get('github'), 'authorized');
      assert.equal(returned.searchParams.get('projectId'), String(secondProject._id));
      assert.equal(revokedUserTokens, beforeRevocations + 1);
      assert.ok(oauthProviderSequence.indexOf('user-token-revocation') > oauthProviderSequence.indexOf('user-installations'));
      assert.ok(oauthProviderSequence.indexOf('app-installation-verification') > oauthProviderSequence.indexOf('user-token-revocation'));
      const record = await GitHubInstallation.findOne({ installationId: '43' });
      assert.ok(record);
      assert.ok(record.authorizedUsers.some((id) => String(id) === String(users.otherOwner._id)));
      assert.equal(await AuditEvent.countDocuments({ projectId: secondProject._id, action: 'github.installation.authorized', targetId: record._id }), 1);
      const authorizationAudit = await AuditEvent.findOne({ projectId: secondProject._id, action: 'github.installation.authorized', targetId: record._id }).lean();
      assert.doesNotMatch(JSON.stringify(authorizationAudit), /ephemeral-user-test-token|ephemeral-test-installation-token|private key|client secret/i);
      const replay = await fetch(`${baseUrl}/integrations/github/oauth/callback?code=existing-install-code&state=${encodeURIComponent(state)}`);
      assert.equal(replay.status, 400);

      const cancelledStart = await api('owner', `/projects/${project.id}/github/installations/authorize`, { method: 'POST' });
      const cancelledState = new URL(cancelledStart.data.authorizationUrl).searchParams.get('state');
      const cancelled = await fetch(`${baseUrl}/integrations/github/oauth/callback?error=access_denied&state=${encodeURIComponent(cancelledState)}`, { redirect: 'manual' });
      assert.equal(cancelled.status, 302);
      assert.equal(new URL(cancelled.headers.get('location')).searchParams.get('github'), 'cancelled');

      oauthCanAccess = false;
      const noInstallStart = await api('owner', `/projects/${project.id}/github/installations/authorize`, { method: 'POST' });
      const noInstallState = new URL(noInstallStart.data.authorizationUrl).searchParams.get('state');
      const noInstall = await fetch(`${baseUrl}/integrations/github/oauth/callback?code=no-install-code&state=${encodeURIComponent(noInstallState)}`, { redirect: 'manual' });
      assert.equal(noInstall.status, 302);
      assert.equal(new URL(noInstall.headers.get('location')).searchParams.get('github'), 'no_installations');
      oauthCanAccess = true;
      oauthInstallationIds = ['42', '44'];
    });

    let linkedId;
    await t.test('authorized repository discovery and linking, duplicate protection, and unlink audit', async () => {
      const listed = await api('owner', `/projects/${project.id}/github/repositories?installationId=42`);
      assert.equal(listed.status, 200);
      assert.equal(listed.data.repositories[0].fullName, 'round3-org/relay-private');
      const forbidden = await api('editor', `/projects/${project.id}/github/repositories?installationId=42`);
      assert.equal(forbidden.status, 403);
      assert.equal((await api('viewer', `/projects/${project.id}/github/repositories?installationId=42`)).status, 403);
      assert.equal((await api('editor', `/projects/${project.id}/github/repositories`, { method: 'POST', body: JSON.stringify({ installationId: '42', repositoryId: '9001' }) })).status, 403);
      assert.equal((await api('viewer', `/projects/${project.id}/github/repositories`, { method: 'POST', body: JSON.stringify({ installationId: '42', repositoryId: '9001' }) })).status, 403);
      const noAccess = await api('owner', `/projects/${project.id}/github/repositories?installationId=999`);
      assert.equal(noAccess.status, 404);
      const inaccessible = await api('owner', `/projects/${project.id}/github/repositories`, { method: 'POST', body: JSON.stringify({ installationId: '42', repositoryId: '9002' }) });
      assert.equal(inaccessible.status, 404);
      const publicOutsideApp = await api('owner', `/projects/${project.id}/github/repositories`, { method: 'POST', body: JSON.stringify({ repositoryId: '9003' }) });
      assert.equal(publicOutsideApp.status, 400);
      repositoryOwner = 'renamed-org';
      repositoryName = 'renamed-repo';
      const link = await api('owner', `/projects/${project.id}/github/repositories`, { method: 'POST', body: JSON.stringify({ installationId: '42', repositoryId: '9001' }) });
      assert.equal(link.status, 201);
      linkedId = link.data.repository.id;
      assert.equal(link.data.repository.fullName, 'renamed-org/renamed-repo');
      const historicalSource = await Source.create({
        project: project._id, provider: 'github', externalType: 'repository', repositoryLink: linkedId,
        externalId: 'repo:9001', originalName: 'renamed-org/renamed-repo', uploadedBy: users.owner._id, status: 'processed',
      });
      sourceIds.push(historicalSource._id);
      const historicalRevision = await SourceRevision.create({
        source: historicalSource._id, revisionKey: 'repo:9001@capture-1', contentHash: 'a'.repeat(64),
        textSnapshot: 'Historical repository snapshot', capturedAt: new Date(),
      });
      revisionIds.push(historicalRevision._id);
      const duplicate = await api('owner', `/projects/${project.id}/github/repositories`, { method: 'POST', body: JSON.stringify({ installationId: '42', repositoryId: '9001' }) });
      assert.equal(duplicate.status, 409);
      assert.equal((await api('editor', `/projects/${project.id}/github/repositories/${linkedId}`, { method: 'DELETE' })).status, 403);
      assert.equal((await api('viewer', `/projects/${project.id}/github/repositories/${linkedId}`, { method: 'DELETE' })).status, 403);
      const unlinked = await api('owner', `/projects/${project.id}/github/repositories/${linkedId}`, { method: 'DELETE' });
      assert.equal(unlinked.status, 200);
      assert.match(unlinked.data.message, /shared GitHub App installation are retained/);
      const preservedLink = await ProjectRepository.findById(linkedId);
      assert.equal(preservedLink.status, 'unlinked');
      assert.equal(String((await Source.findById(historicalSource._id)).repositoryLink), String(linkedId));
      assert.ok(await SourceRevision.findById(historicalRevision._id));
      const linkedView = await api('viewer', `/projects/${project.id}/github/repositories`);
      assert.equal(linkedView.data.repositories.length, 1);
      assert.equal(linkedView.data.repositories[0].status, 'unlinked');
      assert.equal((await api('editor', `/projects/${project.id}/github/repositories/${linkedId}`, { method: 'DELETE' })).status, 403);
      const relink = await api('owner', `/projects/${project.id}/github/repositories`, { method: 'POST', body: JSON.stringify({ installationId: '42', repositoryId: '9001' }) });
      assert.equal(relink.status, 201);
      assert.notEqual(relink.data.repository.id, linkedId);
      assert.equal(String((await Source.findById(historicalSource._id)).repositoryLink), String(linkedId));
      assert.equal(await ProjectRepository.countDocuments({ project: project._id }), 2);
      const events = await AuditEvent.find({ projectId: project._id }).sort({ createdAt: 1 });
      assert.deepEqual(events.map((event) => event.action).sort(), ['github.installation.authorized', 'github.repository.linked', 'github.repository.unlinked', 'github.repository.linked'].sort());
      const unlinkEvent = events.find((event) => event.action === 'github.repository.unlinked');
      assert.equal(String(unlinkEvent.actorId), String(users.owner._id));
      assert.deepEqual(unlinkEvent.githubRepository.toObject(), { repositoryId: '9001', fullName: 'renamed-org/renamed-repo' });
      assert.ok(unlinkEvent.createdAt instanceof Date);
    });

    await t.test('suspended and removed installations are detected before repository access', async () => {
      await GitHubInstallation.updateOne({ installationId: '42' }, { $set: { lastVerifiedAt: new Date(Date.now() - 6 * 60 * 1000) } });
      const stale = await api('owner', `/projects/${project.id}/github/installations`);
      const staleItem = stale.data.installations.find((item) => item.id === '42');
      assert.equal(staleItem.status, 'unverified');
      assert.equal(staleItem.lastKnownStatus, 'active');
      assert.equal(staleItem.statusVerified, false);
      installationMode = 'suspended';
      const suspended = await api('owner', `/projects/${project.id}/github/repositories?installationId=42`);
      assert.equal(suspended.status, 409);
      assert.equal((await GitHubInstallation.findOne({ installationId: '42' })).status, 'suspended');
      const suspendedView = await api('owner', `/projects/${project.id}/github/installations`);
      assert.equal(suspendedView.data.installations.find((item) => item.id === '42').status, 'suspended');
      installationMode = 'active';
      const callback = await completeInstall('owner', project.id, 'update');
      assert.equal(callback.status, 302);
      assert.equal(new URL(callback.location).searchParams.get('github'), 'authorized');
      installationMode = 'removed';
      const removed = await api('owner', `/projects/${project.id}/github/repositories?installationId=42`);
      assert.equal(removed.status, 404);
      assert.equal((await GitHubInstallation.findOne({ installationId: '42' })).status, 'removed');
      const removedView = await api('owner', `/projects/${project.id}/github/installations`);
      assert.equal(removedView.data.installations.find((item) => item.id === '42').status, 'removed');
    });

    await t.test('ownership transfers during provider calls prevent callback and repository-link writes', async () => {
      installationMode = 'active';
      assert.equal((await completeInstall('owner', project.id, 'update')).status, 302);
      await Project.updateOne({ _id: project._id }, { $set: { owner: users.owner._id } });
      let transferred = false;
      providerHook = async (parsed) => {
        if (!transferred && parsed.pathname === '/repositories/9004') {
          transferred = true;
          await Project.updateOne({ _id: project._id }, { $set: { owner: users.editor._id } });
        }
      };
      const linkRace = await api('owner', `/projects/${project.id}/github/repositories`, {
        method: 'POST', body: JSON.stringify({ installationId: '42', repositoryId: '9004' }),
      });
      providerHook = undefined;
      assert.equal(transferred, true);
      assert.equal(linkRace.status, 403);
      assert.equal(await ProjectRepository.countDocuments({ project: project._id, repositoryId: '9004', status: 'active' }), 0);
      await Project.updateOne({ _id: project._id }, { $set: { owner: users.owner._id } });

      const started = await startInstall('owner', project.id);
      const setupState = new URL(started.data.installationUrl).searchParams.get('state');
      let callbackTransfer = false;
      providerHook = async (parsed) => {
        if (!callbackTransfer && parsed.pathname === '/app/installations/44') {
          callbackTransfer = true;
          await Project.updateOne({ _id: project._id }, { $set: { owner: users.editor._id } });
        }
      };
      const setup = await fetch(`${baseUrl}/integrations/github/setup?installation_id=44&setup_action=install&state=${encodeURIComponent(setupState)}`, { redirect: 'manual' });
      providerHook = undefined;
      assert.equal(setup.status, 403);
      assert.equal(callbackTransfer, true);
      await Project.updateOne({ _id: project._id }, { $set: { owner: users.owner._id } });

      const oauthSetupStart = await startInstall('owner', project.id);
      const oauthSetupState = new URL(oauthSetupStart.data.installationUrl).searchParams.get('state');
      const oauthSetup = await fetch(`${baseUrl}/integrations/github/setup?installation_id=44&setup_action=install&state=${encodeURIComponent(oauthSetupState)}`, { redirect: 'manual' });
      const oauthState = new URL(oauthSetup.headers.get('location')).searchParams.get('state');
      let oauthTransfer = false;
      providerHook = async (parsed) => {
        if (!oauthTransfer && parsed.pathname === '/user/installations') {
          oauthTransfer = true;
          await Project.updateOne({ _id: project._id }, { $set: { owner: users.editor._id } });
        }
      };
      const oauthRace = await fetch(`${baseUrl}/integrations/github/oauth/callback?code=owner-race&state=${encodeURIComponent(oauthState)}`, { redirect: 'manual' });
      providerHook = undefined;
      assert.equal(oauthRace.status, 302);
      assert.equal(new URL(oauthRace.headers.get('location')).searchParams.get('github'), 'failed');
      assert.equal(oauthTransfer, true);
      assert.equal(await GitHubInstallation.countDocuments({ installationId: '44' }), 0);
      await Project.updateOne({ _id: project._id }, { $set: { owner: users.owner._id } });
    });

    await t.test('concurrent first-time authorization reconciles one installation and one event per actor', async () => {
      async function setupFor(role, projectId) {
        const started = await startInstall(role, projectId);
        assert.equal(started.status, 201);
        const setupState = new URL(started.data.installationUrl).searchParams.get('state');
        const setup = await fetch(`${baseUrl}/integrations/github/setup?installation_id=44&setup_action=install&state=${encodeURIComponent(setupState)}`, { redirect: 'manual' });
        assert.equal(setup.status, 302);
        return new URL(setup.headers.get('location')).searchParams.get('state');
      }
      const [ownerState, otherOwnerState] = await Promise.all([
        setupFor('owner', project.id), setupFor('otherOwner', secondProject.id),
      ]);
      const [ownerResult, otherOwnerResult] = await Promise.all([
        fetch(`${baseUrl}/integrations/github/oauth/callback?code=parallel-owner&state=${encodeURIComponent(ownerState)}`, { redirect: 'manual' }),
        fetch(`${baseUrl}/integrations/github/oauth/callback?code=parallel-other-owner&state=${encodeURIComponent(otherOwnerState)}`, { redirect: 'manual' }),
      ]);
      assert.deepEqual([ownerResult.status, otherOwnerResult.status].sort(), [302, 302]);
      const record = await GitHubInstallation.findOne({ installationId: '44' });
      assert.ok(record);
      assert.deepEqual(record.authorizedUsers.map(String).sort(), [String(users.owner._id), String(users.otherOwner._id)].sort());
      assert.equal(await GitHubInstallation.countDocuments({ installationId: '44' }), 1);
      assert.equal(await AuditEvent.countDocuments({ targetId: record._id, action: 'github.installation.authorized' }), 2);
    });

    await t.test('former owner cannot unlink after ownership transfer', async () => {
      const activeLink = await ProjectRepository.findOne({ project: project._id, status: 'active' });
      assert.ok(activeLink);
      await Project.updateOne({ _id: project._id }, { $set: { owner: users.editor._id } });
      const denied = await api('owner', `/projects/${project.id}/github/repositories/${activeLink._id}`, { method: 'DELETE' });
      assert.equal(denied.status, 403);
      assert.equal((await ProjectRepository.findById(activeLink._id)).status, 'active');
      await Project.updateOne({ _id: project._id }, { $set: { owner: users.owner._id } });
    });

    await t.test('state expired or owned by an actor who no longer owns the project is rejected', async () => {
      installationMode = 'active';
      const pending = await api('owner', `/projects/${project.id}/github/installations/start`, { method: 'POST' });
      const pendingState = new URL(pending.data.installationUrl).searchParams.get('state');
      const active = await GitHubInstallState.findOne({ stateHash: hashInstallState(pendingState), consumedAt: { $exists: false } });
      assert.ok(active);
      await GitHubInstallState.updateOne({ _id: active._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      const expired = await fetch(`${baseUrl}/integrations/github/setup?installation_id=42&state=${encodeURIComponent(pendingState)}`);
      assert.equal(expired.status, 400);
      const secondStart = await api('owner', `/projects/${project.id}/github/installations/start`, { method: 'POST' });
      const state = new URL(secondStart.data.installationUrl).searchParams.get('state');
      const setupResponse = await fetch(`${baseUrl}/integrations/github/setup?installation_id=42&setup_action=install&state=${encodeURIComponent(state)}`, { redirect: 'manual' });
      assert.equal(setupResponse.status, 302);
      const oauthState = new URL(setupResponse.headers.get('location')).searchParams.get('state');
      await Project.updateOne({ _id: project._id }, { $set: { owner: users.editor._id } });
      const staleOwner = await fetch(`${baseUrl}/integrations/github/oauth/callback?code=valid-one-time-code&state=${encodeURIComponent(oauthState)}`);
      assert.equal(staleOwner.status, 403);
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (mongoose.connection.readyState) {
      await Promise.all([
        SourceRevision.deleteMany({ _id: { $in: revisionIds } }),
        Source.deleteMany({ _id: { $in: sourceIds } }),
        ProjectRepository.deleteMany({ project: { $in: projectIds } }),
        GitHubInstallState.deleteMany({ project: { $in: projectIds } }),
        GitHubInstallation.deleteMany({ authorizedUsers: { $in: userIds } }),
        ProjectAssignment.deleteMany({ project: { $in: projectIds } }),
        AuditEvent.deleteMany({ projectId: { $in: projectIds } }),
        Project.deleteMany({ _id: { $in: projectIds } }),
        User.deleteMany({ _id: { $in: userIds } }),
      ]);
      await mongoose.disconnect();
    }
    for (const [key, value] of Object.entries(previousEnv)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});
