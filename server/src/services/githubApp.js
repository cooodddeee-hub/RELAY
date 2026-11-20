import { createSign, createHash, randomBytes } from 'node:crypto';
import {
  GITHUB_CONTENT_LIMITS,
  createGitHubContentBudget,
  createGitHubRevisionKey,
  hashGitHubContent,
  normalizeGitHubText,
} from './githubContent.js';

const API_ROOT = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const STATE_TTL_MS = 10 * 60 * 1000;
const STATUS_VERIFICATION_FRESH_MS = 5 * 60 * 1000;
export const GITHUB_PROVIDER_LIMITS = Object.freeze({
  rawResponseBytes: 2 * 1024 * 1024,
  commits: 50,
  issuePages: 5,
  issuePageSize: 100,
});
const MAX_GITHUB_RESPONSE_BYTES = GITHUB_PROVIDER_LIMITS.rawResponseBytes;
const MAX_COMMIT_COUNT = GITHUB_PROVIDER_LIMITS.commits;
const MAX_ISSUE_PAGES = GITHUB_PROVIDER_LIMITS.issuePages;
const ISSUE_PAGE_SIZE = GITHUB_PROVIDER_LIMITS.issuePageSize;

export class GitHubApiError extends Error {
  constructor(code, status = 502, retryAfter) {
    super(code);
    this.name = 'GitHubApiError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export function readGitHubConfig(env = process.env) {
  const appId = env.GITHUB_APP_ID?.trim();
  const slug = env.GITHUB_APP_SLUG?.trim();
  const privateKey = env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const clientId = env.GITHUB_APP_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET?.trim();
  const setupUrl = safeCallbackUrl(env.GITHUB_APP_SETUP_URL?.trim(), '/api/integrations/github/setup');
  const oauthCallbackUrl = safeCallbackUrl(env.GITHUB_APP_OAUTH_CALLBACK_URL?.trim(), '/api/integrations/github/oauth/callback');
  if (!appId || !slug || !privateKey || !clientId || !clientSecret || !setupUrl || !oauthCallbackUrl) return null;
  return { appId, slug, privateKey, clientId, clientSecret, setupUrl, oauthCallbackUrl };
}

function safeCallbackUrl(value, expectedPath) {
  if (!value) return null;
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (!['https:', 'http:'].includes(parsed.protocol)
    || (parsed.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(parsed.hostname))
    || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== expectedPath) return null;
  return parsed.toString();
}

export function hashInstallState(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function createInstallState() {
  return randomBytes(32).toString('base64url');
}

export function installationSetupUrl(slug, state) {
  const url = new URL(`https://github.com/apps/${encodeURIComponent(slug)}/installations/new`);
  url.searchParams.set('state', state);
  return url.toString();
}

export function oauthAuthorizationUrl(config, state) {
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.oauthCallbackUrl);
  url.searchParams.set('state', state);
  return url.toString();
}

export function createAppJwt({ appId, privateKey, now = Date.now() }) {
  const issuedAt = Math.floor(now / 1000) - 30;
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iat: issuedAt, exp: issuedAt + 8 * 60, iss: appId })).toString('base64url');
  const data = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(data);
  signer.end();
  return `${data}.${signer.sign(privateKey, 'base64url')}`;
}

function safeRetryAfter(response, now = Date.now()) {
  const raw = response.headers.get('retry-after');
  if (typeof raw === 'string' && /^\d{1,6}$/.test(raw)) {
    const seconds = Number(raw);
    if (seconds >= 1 && seconds <= 86_400) return String(seconds);
  }
  const reset = response.headers.get('x-ratelimit-reset');
  if (typeof reset === 'string' && /^\d{1,12}$/.test(reset)) {
    const seconds = Number(reset) - Math.floor(now / 1000);
    if (seconds >= 1 && seconds <= 86_400) return String(seconds);
  }
  return undefined;
}

function classifyRequestError(error) {
  if (error instanceof GitHubApiError) return error;
  const timeoutCodes = new Set(['ETIMEDOUT', 'ERR_SOCKET_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1, current = current.cause) {
    if (current.name === 'TimeoutError' || current.name === 'AbortError' || timeoutCodes.has(current.code)) {
      return new GitHubApiError('GITHUB_TIMEOUT', 504);
    }
  }
  return new GitHubApiError('GITHUB_UNAVAILABLE', 502);
}

async function readBoundedJson(response, maxBytes = MAX_GITHUB_RESPONSE_BYTES) {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) throw new GitHubApiError('GITHUB_INVALID_RESPONSE', 502);
    if (Number(contentLength) > maxBytes) {
      try { await response.body?.cancel(); } catch {}
      throw new GitHubApiError('GITHUB_RESPONSE_TOO_LARGE', 502);
    }
  }

  if (!response.body) throw new GitHubApiError('GITHUB_INVALID_RESPONSE', 502);
  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        try { await reader.cancel(); } catch {}
        throw new GitHubApiError('GITHUB_RESPONSE_TOO_LARGE', 502);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    try { await reader.cancel(); } catch {}
    throw classifyRequestError(error);
  } finally {
    reader.releaseLock();
  }

  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, byteLength)); }
  catch { throw new GitHubApiError('GITHUB_INVALID_RESPONSE', 502); }
  try { return JSON.parse(text); }
  catch { throw new GitHubApiError('GITHUB_INVALID_RESPONSE', 502); }
}

async function githubRequest(path, { token, method = 'GET', body, fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const url = new URL(path, API_ROOT);
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': API_VERSION,
        'user-agent': 'RELAY-Handover',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) { throw classifyRequestError(error); }
  if (!response.ok) {
    const retryAfter = safeRetryAfter(response);
    if (response.status === 401) throw new GitHubApiError('GITHUB_AUTH_EXPIRED', 502);
    if (response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || retryAfter))) {
      throw new GitHubApiError('GITHUB_RATE_LIMITED', 503, retryAfter);
    }
    if (response.status === 404) throw new GitHubApiError('GITHUB_RESOURCE_UNAVAILABLE', 404);
    if (response.status === 403) throw new GitHubApiError('GITHUB_ACCESS_DENIED', 403);
    throw new GitHubApiError('GITHUB_PROVIDER_ERROR', 502);
  }
  return readBoundedJson(response);
}

export async function getInstallation({ installationId, config = readGitHubConfig(), fetchImpl = fetch, timeoutMs = 10000 }) {
  if (!config) throw new GitHubApiError('GITHUB_NOT_CONFIGURED', 503);
  const jwt = createAppJwt(config);
  const result = await githubRequest(`/app/installations/${encodeURIComponent(installationId)}`, { token: jwt, fetchImpl, timeoutMs });
  return result;
}

export async function createInstallationToken({ installationId, config = readGitHubConfig(), fetchImpl = fetch, timeoutMs = 10000 }) {
  if (!config) throw new GitHubApiError('GITHUB_NOT_CONFIGURED', 503);
  const jwt = createAppJwt(config);
  const result = await githubRequest(`/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
    token: jwt,
    method: 'POST',
    body: { permissions: { contents: 'read', issues: 'read' } },
    fetchImpl, timeoutMs,
  });
  if (typeof result.token !== 'string' || !result.expires_at || !hasReadOnlyPermissions(result.permissions)) throw new GitHubApiError('GITHUB_PERMISSIONS_INVALID', 403);
  return { token: result.token, expiresAt: result.expires_at };
}

export async function listInstallationRepositories({ installationId, page = 1, config, fetchImpl = fetch }) {
  const { token } = await createInstallationToken({ installationId, config, fetchImpl });
  const result = await githubRequest(`/installation/repositories?per_page=100&page=${page}`, { token, fetchImpl });
  if (!Array.isArray(result.repositories)) throw new GitHubApiError('GITHUB_INVALID_RESPONSE', 502);
  return result.repositories;
}

export async function getInstallationRepository({ installationId, repositoryId, config, fetchImpl = fetch, timeoutMs = 10000, getTimeoutMs }) {
  const tokenTimeout = getTimeoutMs ? await getTimeoutMs() : timeoutMs;
  const { token } = await createInstallationToken({ installationId, config, fetchImpl, timeoutMs: tokenTimeout });
  const requestTimeout = getTimeoutMs ? await getTimeoutMs() : timeoutMs;
  return githubRequest(`/repositories/${encodeURIComponent(repositoryId)}`, { token, fetchImpl, timeoutMs: requestTimeout });
}

function encodeRepositorySegment(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(value) || value === '.' || value === '..') {
    throw new GitHubApiError('GITHUB_INVALID_REPOSITORY', 400);
  }
  return encodeURIComponent(value);
}

function repositoryPath(ownerLogin, repositoryName) {
  return `/repos/${encodeRepositorySegment(ownerLogin)}/${encodeRepositorySegment(repositoryName)}`;
}

function decodeGitHubBase64Content(value) {
  if (typeof value !== 'string') throw new GitHubApiError('GITHUB_INVALID_RESPONSE', 502);
  const compact = value.replace(/[\r\n\t ]/g, '');
  if (compact.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
    throw new GitHubApiError('GITHUB_INVALID_RESPONSE', 502);
  }
  const bytes = Buffer.from(compact, 'base64');
  if (bytes.toString('base64') !== compact) throw new GitHubApiError('GITHUB_INVALID_RESPONSE', 502);
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new GitHubApiError('GITHUB_INVALID_RESPONSE', 502); }
}

function validateGitHubDate(value, required = false) {
  if (value === null || value === undefined) {
    if (required) throw new GitHubApiError('GITHUB_INVALID_RESPONSE', 502);
    return undefined;
  }
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new GitHubApiError('GITHUB_INVALID_RESPONSE', 502);
  return new Date(value);
}

function validateRepositoryId(value) {
  if (!(typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
    && !(typeof value === 'string' && /^\d{1,24}$/.test(value))) {
    throw new GitHubApiError('GITHUB_INVALID_RESPONSE', 502);
  }
  return String(value);
}

function validateCommit(commit) {
  if (!commit || typeof commit !== 'object' || Array.isArray(commit)
    || typeof commit.sha !== 'string' || !/^[a-f\d]{40,64}$/i.test(commit.sha)
    || !commit.commit || typeof commit.commit !== 'object'
    || typeof commit.commit.message !== 'string') {
    throw new GitHubApiError('GITHUB_INVALID_RESPONSE', 502);
  }
  const date = validateGitHubDate(commit.commit.author?.date);
  return {
    sha: commit.sha.toLowerCase(),
    message: commit.commit.message,
    ...(date ? { authoredAt: date } : {}),
  };
}

function validateIssue(issue) {
  if (!issue || typeof issue !== 'object' || Array.isArray(issue)
    || !Number.isSafeInteger(issue.id) || issue.id <= 0
    || !Number.isSafeInteger(issue.number) || issue.number <= 0
    || typeof issue.title !== 'string'
    || !(issue.body === null || typeof issue.body === 'string')
    || !['open', 'closed'].includes(issue.state)) {
    throw new GitHubApiError('GITHUB_INVALID_RESPONSE', 502);
  }
  return {
    id: String(issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body || '',
    state: issue.state,
    updatedAt: validateGitHubDate(issue.updated_at, true),
    isPullRequest: Object.hasOwn(issue, 'pull_request'),
  };
}

export async function getRepositoryReadme({ installationId, ownerLogin, repositoryName, config, fetchImpl = fetch, contentBudget = createGitHubContentBudget(), timeoutMs = 10000, getTimeoutMs }) {
  const tokenTimeout = getTimeoutMs ? await getTimeoutMs() : timeoutMs;
  const { token } = await createInstallationToken({ installationId, config, fetchImpl, timeoutMs: tokenTimeout });
  let result;
  try {
    const requestTimeout = getTimeoutMs ? await getTimeoutMs() : timeoutMs;
    result = await githubRequest(`${repositoryPath(ownerLogin, repositoryName)}/readme`, { token, fetchImpl, timeoutMs: requestTimeout });
  } catch (error) {
    if (error instanceof GitHubApiError && error.code === 'GITHUB_RESOURCE_UNAVAILABLE') return null;
    throw error;
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || typeof result.name !== 'string' || typeof result.path !== 'string'
    || result.path.length < 1 || result.path.length > 500 || result.path.startsWith('/')
    || result.path.includes('\\') || /[\u0000-\u001f\u007f]/.test(result.path)
    || result.path.split('/').some((part) => !part || part === '.' || part === '..')
    || typeof result.sha !== 'string' || !/^[a-f\d]{40,64}$/i.test(result.sha)
    || result.encoding !== 'base64' || !Number.isSafeInteger(result.size) || result.size < 0) {
    throw new GitHubApiError('GITHUB_INVALID_RESPONSE', 502);
  }
  const decodedText = decodeGitHubBase64Content(result.content);
  if (Buffer.byteLength(decodedText, 'utf8') !== result.size) throw new GitHubApiError('GITHUB_INVALID_RESPONSE', 502);
  const bounded = contentBudget.capture('readme', decodedText, GITHUB_CONTENT_LIMITS.readmeItem);
  return {
    name: result.name,
    path: result.path,
    sha: result.sha.toLowerCase(),
    text: bounded.text,
    truncated: bounded.truncated,
    originalBytes: bounded.originalBytes,
    contentBytes: bounded.contentBytes,
    revisionKey: createGitHubRevisionKey({ externalType: 'readme', externalId: result.path, upstreamRevision: result.sha, contentHash: hashGitHubContent(bounded.text) }),
    contentHash: hashGitHubContent(bounded.text),
  };
}

export async function getRecentRepositoryCommits({ installationId, ownerLogin, repositoryName, defaultBranch, config, fetchImpl = fetch, contentBudget = createGitHubContentBudget(), timeoutMs = 10000, getTimeoutMs, excludeShas = [] }) {
  const tokenTimeout = getTimeoutMs ? await getTimeoutMs() : timeoutMs;
  const { token } = await createInstallationToken({ installationId, config, fetchImpl, timeoutMs: tokenTimeout });
  const query = new URLSearchParams({ per_page: String(MAX_COMMIT_COUNT), page: '1' });
  if (defaultBranch) {
    if (typeof defaultBranch !== 'string' || defaultBranch.length > 255 || /[\r\n]/.test(defaultBranch)) throw new GitHubApiError('GITHUB_INVALID_REPOSITORY', 400);
    query.set('sha', defaultBranch);
  }
  const requestTimeout = getTimeoutMs ? await getTimeoutMs() : timeoutMs;
  const result = await githubRequest(`${repositoryPath(ownerLogin, repositoryName)}/commits?${query}`, { token, fetchImpl, timeoutMs: requestTimeout });
  if (!Array.isArray(result) || result.length > MAX_COMMIT_COUNT) throw new GitHubApiError('GITHUB_INVALID_RESPONSE', 502);
  const excluded = new Set(excludeShas.map((sha) => String(sha).toLowerCase()));
  return result.map((entry) => {
    const commit = validateCommit(entry);
    if (excluded.has(commit.sha)) return null;
    const bounded = contentBudget.capture('commits', commit.message, GITHUB_CONTENT_LIMITS.commitItem);
    const contentHash = hashGitHubContent(bounded.text);
    return {
      ...commit,
      message: bounded.text,
      truncated: bounded.truncated,
      originalBytes: bounded.originalBytes,
      contentBytes: bounded.contentBytes,
      contentHash,
      revisionKey: createGitHubRevisionKey({ externalType: 'commit', externalId: commit.sha, upstreamRevision: commit.sha, contentHash }),
    };
  }).filter(Boolean);
}

export async function listRecentRepositoryIssues({ installationId, ownerLogin, repositoryName, config, fetchImpl = fetch, contentBudget = createGitHubContentBudget(), timeoutMs = 10000, getTimeoutMs, startPage = 1, initialIssueCount = 0, initialPagesScanned = 0, initialRawEntriesScanned = 0, knownIssueUpdatedAtByNumber = {}, onPage }) {
  const tokenTimeout = getTimeoutMs ? await getTimeoutMs() : timeoutMs;
  const { token } = await createInstallationToken({ installationId, config, fetchImpl, timeoutMs: tokenTimeout });
  const issues = [];
  let pagesScanned = initialPagesScanned;
  let rawEntriesScanned = initialRawEntriesScanned;
  let issueCount = initialIssueCount;
  let exhausted = false;
  const knownUpdated = knownIssueUpdatedAtByNumber instanceof Map
    ? knownIssueUpdatedAtByNumber
    : new Map(Object.entries(knownIssueUpdatedAtByNumber).map(([number, date]) => [String(number), new Date(date)]));

  for (let page = startPage; page <= MAX_ISSUE_PAGES && issueCount < ISSUE_PAGE_SIZE; page += 1) {
    const query = new URLSearchParams({ state: 'all', sort: 'updated', direction: 'desc', per_page: String(ISSUE_PAGE_SIZE), page: String(page) });
    const requestTimeout = getTimeoutMs ? await getTimeoutMs() : timeoutMs;
    const result = await githubRequest(`${repositoryPath(ownerLogin, repositoryName)}/issues?${query}`, { token, fetchImpl, timeoutMs: requestTimeout });
    if (!Array.isArray(result) || result.length > ISSUE_PAGE_SIZE) throw new GitHubApiError('GITHUB_INVALID_RESPONSE', 502);
    pagesScanned += 1;
    rawEntriesScanned += result.length;
    const pageIssues = [];
    let pullRequestsSkipped = 0;
    for (const item of result) {
      const issue = validateIssue(item);
      if (issue.isPullRequest) { pullRequestsSkipped += 1; continue; }
      issueCount += 1;
      const knownUpdatedAt = knownUpdated.get(String(issue.number));
      if (knownUpdatedAt && knownUpdatedAt >= issue.updatedAt) {
        if (issueCount === ISSUE_PAGE_SIZE) break;
        continue;
      }
      const bounded = contentBudget.captureRecord('issues', { title: issue.title, body: issue.body }, GITHUB_CONTENT_LIMITS.issueItem);
      const contentHash = hashGitHubContent(bounded.text);
      issues.push({
        id: issue.id,
        number: issue.number,
        title: bounded.fields.title,
        body: bounded.fields.body,
        text: bounded.text,
        state: issue.state,
        updatedAt: issue.updatedAt,
        truncated: bounded.truncated,
        originalBytes: bounded.originalBytes,
        contentBytes: bounded.contentBytes,
        contentHash,
        revisionKey: createGitHubRevisionKey({
          externalType: 'issue',
          externalId: String(issue.number),
          upstreamRevision: issue.updatedAt.toISOString(),
          contentHash,
        }),
      });
      pageIssues.push(issues.at(-1));
      if (issueCount === ISSUE_PAGE_SIZE) break;
    }
    if (result.length < ISSUE_PAGE_SIZE) exhausted = true;
    const scanLimitReached = !exhausted && page === MAX_ISSUE_PAGES && issueCount < ISSUE_PAGE_SIZE;
    const issueLimitReached = issueCount >= ISSUE_PAGE_SIZE;
    if (onPage) await onPage({ page, rawEntries: result.length, pageIssues, issueCount, pagesScanned, rawEntriesScanned, pullRequestsSkipped, exhausted, scanLimitReached, issueLimitReached });
    if (issueLimitReached) break;
    if (exhausted) {
      break;
    }
  }

  const scanLimitReached = !exhausted && pagesScanned >= MAX_ISSUE_PAGES && issueCount < ISSUE_PAGE_SIZE;
  return {
    issues,
    pagesScanned,
    rawEntriesScanned,
    issueCount,
    complete: !scanLimitReached,
    ...(scanLimitReached ? { partialReason: 'issue_scan_limit_reached' } : {}),
  };
}

async function oauthRequest(url, options, fetchImpl) {
  let response;
  try { response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(10000) }); }
  catch (error) { throw classifyRequestError(error); }
  if (!response.ok) throw new GitHubApiError('GITHUB_USER_AUTH_FAILED', 502);
  return readBoundedJson(response);
}

export async function exchangeUserCode({ code, config = readGitHubConfig(), fetchImpl = fetch }) {
  if (!config) throw new GitHubApiError('GITHUB_NOT_CONFIGURED', 503);
  const result = await oauthRequest('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'RELAY-Handover' },
    body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: config.oauthCallbackUrl }),
  }, fetchImpl);
  if (typeof result.access_token !== 'string' || result.error) throw new GitHubApiError('GITHUB_USER_AUTH_FAILED', 502);
  return result.access_token;
}

export async function listUserInstallations({ accessToken, fetchImpl = fetch }) {
  const [user, result] = await Promise.all([
    githubRequest('/user', { token: accessToken, fetchImpl }),
    githubRequest('/user/installations?per_page=100', { token: accessToken, fetchImpl }),
  ]);
  if (!user?.id || !user?.login || !Array.isArray(result.installations)) throw new GitHubApiError('GITHUB_INVALID_RESPONSE', 502);
  const installations = result.installations.map((item) => {
    if (!item?.id || !/^\d{1,24}$/.test(String(item.id))) throw new GitHubApiError('GITHUB_INVALID_RESPONSE', 502);
    return { id: String(item.id) };
  });
  return { user: { id: String(user.id), login: user.login }, installations };
}

export async function verifyUserCanAccessInstallation({ accessToken, installationId, fetchImpl = fetch }) {
  const result = await listUserInstallations({ accessToken, fetchImpl });
  return { user: result.user, authorized: result.installations.some((item) => item.id === String(installationId)) };
}

export async function revokeUserAccessToken({ accessToken, config = readGitHubConfig(), fetchImpl = fetch }) {
  if (!config) throw new GitHubApiError('GITHUB_NOT_CONFIGURED', 503);
  let response;
  try {
    response = await fetchImpl(`https://api.github.com/applications/${encodeURIComponent(config.clientId)}/token`, {
      method: 'DELETE',
      headers: {
        accept: 'application/vnd.github+json', 'x-github-api-version': API_VERSION,
        authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
        'content-type': 'application/json', 'user-agent': 'RELAY-Handover',
      },
      body: JSON.stringify({ access_token: accessToken }),
      signal: AbortSignal.timeout(10000),
    });
  } catch { throw new GitHubApiError('GITHUB_TOKEN_REVOCATION_FAILED', 502); }
  if (!response.ok && response.status !== 404) throw new GitHubApiError('GITHUB_TOKEN_REVOCATION_FAILED', 502);
}

export function safeInstallationStatus(installation) {
  if (!installation || !installation.id || !installation.account?.id || !installation.account?.login) throw new GitHubApiError('GITHUB_INVALID_RESPONSE', 502);
  if (installation.suspended_at) return 'suspended';
  const permissions = installation.permissions || {};
  if (!hasReadOnlyPermissions(permissions)) throw new GitHubApiError('GITHUB_PERMISSIONS_INVALID', 403);
  return 'active';
}

export function installationStatusSummary(installation, now = Date.now()) {
  const lastVerifiedAt = installation.lastVerifiedAt || null;
  const age = lastVerifiedAt ? now - new Date(lastVerifiedAt).getTime() : Number.POSITIVE_INFINITY;
  const statusVerified = age >= 0 && age <= STATUS_VERIFICATION_FRESH_MS;
  return {
    status: installation.status === 'active' && !statusVerified ? 'unverified' : installation.status,
    lastKnownStatus: installation.status,
    statusVerified,
    lastVerifiedAt,
  };
}

function hasReadOnlyPermissions(permissions) {
  if (!permissions || permissions.contents !== 'read' || permissions.issues !== 'read') return false;
  return Object.entries(permissions).every(([name, permission]) => (
    ['contents', 'issues', 'metadata'].includes(name) && permission === 'read'
  ));
}

export const installStateTtlMs = STATE_TTL_MS;
