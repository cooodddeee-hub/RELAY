import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import {
  createAppJwt, createInstallState, getInstallationRepository, hashInstallState,
  exchangeUserCode, installationSetupUrl, listInstallationRepositories, listUserInstallations, oauthAuthorizationUrl,
  readGitHubConfig, revokeUserAccessToken, safeInstallationStatus, verifyUserCanAccessInstallation,
  installationStatusSummary, GitHubApiError,
} from '../src/services/githubApp.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const config = { appId: '123', privateKey: keyPem, slug: 'relay-test', clientId: 'client-id', clientSecret: 'client-secret', setupUrl: 'http://127.0.0.1:5001/api/integrations/github/setup', oauthCallbackUrl: 'http://127.0.0.1:5001/api/integrations/github/oauth/callback' };

test('GitHub App JWT is short-lived and signed; installation state is random and hashed', () => {
  const jwt = createAppJwt({ ...config, now: 1_800_000_000_000 });
  const [header, payload, signature] = jwt.split('.');
  const data = `${header}.${payload}`;
  assert.equal(verify('RSA-SHA256', Buffer.from(data), publicKey, Buffer.from(signature, 'base64url')), true);
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.equal(claims.iss, '123');
  assert.equal(claims.exp - claims.iat, 8 * 60);
  const state = createInstallState();
  assert.ok(state.length >= 40);
  assert.notEqual(hashInstallState(state), state);
  const setupUrl = new URL(installationSetupUrl(config.slug, state));
  assert.equal(setupUrl.origin, 'https://github.com');
  assert.equal(setupUrl.searchParams.get('state'), state);
  assert.equal(setupUrl.searchParams.has('redirect_uri'), false);
  const oauthUrl = new URL(oauthAuthorizationUrl(config, state));
  assert.equal(oauthUrl.hostname, 'github.com');
  assert.equal(oauthUrl.searchParams.get('client_id'), config.clientId);
  assert.equal(oauthUrl.searchParams.get('state'), state);
});

test('GitHub configuration is optional and rejects unsafe callback URLs', () => {
  assert.equal(readGitHubConfig({}), null);
  const env = { GITHUB_APP_ID: '1', GITHUB_APP_SLUG: 'relay', GITHUB_APP_PRIVATE_KEY: keyPem, GITHUB_APP_CLIENT_ID: 'client', GITHUB_APP_CLIENT_SECRET: 'secret', GITHUB_APP_SETUP_URL: 'https://relay.example/api/integrations/github/setup', GITHUB_APP_OAUTH_CALLBACK_URL: 'https://relay.example/api/integrations/github/oauth/callback' };
  assert.equal(readGitHubConfig({ ...env, GITHUB_APP_SETUP_URL: 'http://example.com/api/integrations/github/setup' }), null);
  assert.equal(readGitHubConfig({ ...env, GITHUB_APP_OAUTH_CALLBACK_URL: 'https://relay.example/other' }), null);
  assert.equal(readGitHubConfig(env).appId, '1');
});

test('installation status requires read-only Contents and Issues permissions', () => {
  assert.equal(safeInstallationStatus({ id: 1, account: { id: 2, login: 'org' }, permissions: { contents: 'read', issues: 'read' } }), 'active');
  assert.equal(safeInstallationStatus({ id: 1, account: { id: 2, login: 'org' }, suspended_at: 'now', permissions: {} }), 'suspended');
  assert.throws(() => safeInstallationStatus({ id: 1, account: { id: 2, login: 'org' }, permissions: { contents: 'write', issues: 'read' } }), { code: 'GITHUB_PERMISSIONS_INVALID' });
  assert.throws(() => safeInstallationStatus({ id: 1, account: { id: 2, login: 'org' }, permissions: { contents: 'read', issues: 'read', administration: 'write' } }), { code: 'GITHUB_PERMISSIONS_INVALID' });
});

test('installation status summary marks stale active state unverified and preserves known suspended or removed states', () => {
  const now = Date.parse('2026-11-17T12:00:00.000Z');
  const stale = installationStatusSummary({ status: 'active', lastVerifiedAt: new Date(now - 6 * 60 * 1000) }, now);
  assert.equal(stale.status, 'unverified');
  assert.equal(stale.lastKnownStatus, 'active');
  assert.equal(stale.statusVerified, false);
  assert.equal(installationStatusSummary({ status: 'active', lastVerifiedAt: new Date(now - 60 * 1000) }, now).status, 'active');
  assert.equal(installationStatusSummary({ status: 'suspended', lastVerifiedAt: new Date(now) }, now).status, 'suspended');
  assert.equal(installationStatusSummary({ status: 'removed', lastVerifiedAt: new Date(now) }, now).status, 'removed');
  assert.equal(installationStatusSummary({ status: 'active' }, now).status, 'unverified');
});

test('repository API calls use short-lived tokens and return provider errors without response secrets', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url: String(url), options });
    if (String(url).includes('/access_tokens')) return new Response(JSON.stringify({ token: 'short-token-value', expires_at: '2026-11-17T12:00:00Z', permissions: { contents: 'read', issues: 'read' } }), { status: 201 });
    if (String(url).includes('/installation/repositories')) return new Response(JSON.stringify({ repositories: [{ id: 44, full_name: 'org/repo' }] }), { status: 200 });
    return new Response(JSON.stringify({ id: 44, owner: { login: 'org' }, name: 'repo', full_name: 'org/repo', html_url: 'https://github.com/org/repo' }), { status: 200 });
  };
  const list = await listInstallationRepositories({ installationId: '88', config, fetchImpl });
  assert.equal(list[0].id, 44);
  const repository = await getInstallationRepository({ installationId: '88', repositoryId: '44', config, fetchImpl });
  assert.equal(repository.id, 44);
  assert.ok(seen.some(({ options }) => options.body?.includes('"contents":"read"')));
  assert.ok(seen.some(({ options }) => options.headers.authorization === 'Bearer short-token-value'));
  assert.equal(JSON.stringify(seen.map(({ url }) => url)).includes('short-token-value'), false);

  await assert.rejects(() => listInstallationRepositories({ installationId: '88', config, fetchImpl: async () => new Response(JSON.stringify({ message: 'token=secret' }), { status: 401 }) }), (error) => {
    assert.ok(error instanceof GitHubApiError);
    assert.equal(error.code, 'GITHUB_AUTH_EXPIRED');
    assert.equal(error.message.includes('secret'), false);
    return true;
  });
});

test('rate-limit and inaccessible resource failures have stable safe codes', async () => {
  const rateLimitFetch = async () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'retry-after': '30' } });
  await assert.rejects(() => listInstallationRepositories({ installationId: '88', config, fetchImpl: rateLimitFetch }), { code: 'GITHUB_RATE_LIMITED', retryAfter: '30' });
  const missingFetch = async () => new Response('{}', { status: 404 });
  await assert.rejects(() => getInstallationRepository({ installationId: '88', repositoryId: '44', config, fetchImpl: missingFetch }), { code: 'GITHUB_RESOURCE_UNAVAILABLE' });
});

test('GitHub user authorization verifies installation access and revokes transient credentials', async () => {
  const seen = [];
  const fetchImpl = async (url, options = {}) => {
    seen.push({ url: String(url), options });
    if (String(url).includes('/login/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'transient-user-token' }), { status: 200 });
    if (String(url).endsWith('/user')) return new Response(JSON.stringify({ id: 88, login: 'authorized-user' }), { status: 200 });
    if (String(url).includes('/user/installations')) return new Response(JSON.stringify({ installations: [{ id: 900 }] }), { status: 200 });
    if (String(url).includes('/applications/client-id/token')) return new Response(null, { status: 204 });
    return new Response('{}', { status: 500 });
  };
  const accessToken = await exchangeUserCode({ code: 'one-time-code', config, fetchImpl });
  const result = await verifyUserCanAccessInstallation({ accessToken, installationId: '900', fetchImpl });
  assert.deepEqual(result, { user: { id: '88', login: 'authorized-user' }, authorized: true });
  const installations = await listUserInstallations({ accessToken, fetchImpl });
  assert.deepEqual(installations.installations, [{ id: '900' }]);
  await revokeUserAccessToken({ accessToken, config, fetchImpl });
  const revocation = seen.find(({ url }) => url.includes('/applications/client-id/token'));
  assert.equal(revocation.options.method, 'DELETE');
  assert.equal(JSON.parse(revocation.options.body).access_token, 'transient-user-token');
  assert.ok(revocation.options.headers.authorization.startsWith('Basic '));
});
