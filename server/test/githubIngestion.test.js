import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  GitHubApiError,
  GITHUB_PROVIDER_LIMITS,
  exchangeUserCode,
  getRecentRepositoryCommits,
  getRepositoryReadme,
  listRecentRepositoryIssues,
} from '../src/services/githubApp.js';
import {
  GITHUB_CONTENT_LIMITS,
  createGitHubContentBudget,
  createGitHubRevisionKey,
  hashGitHubContent,
  normalizeGitHubText,
  truncateUtf8,
  utf8ByteLength,
} from '../src/services/githubContent.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const config = { appId: '123', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), slug: 'relay-test', clientId: 'client', clientSecret: 'secret' };
const installationId = '99';

function tokenResponse() {
  return new Response(JSON.stringify({ token: 'test-install-token', expires_at: '2026-11-17T12:00:00Z', permissions: { contents: 'read', issues: 'read' } }), { status: 201 });
}

function providerFetch(handler) {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: new URL(String(url)), options });
    if (String(url).includes('/access_tokens')) return tokenResponse();
    return handler(new URL(String(url)), options, requests.length);
  };
  return { fetchImpl, requests };
}

function issue(number, overrides = {}) {
  return {
    id: number + 1000,
    number,
    title: `Issue ${number}`,
    body: `Body ${number}`,
    state: number % 2 ? 'open' : 'closed',
    updated_at: `2026-11-${String((number % 27) + 1).padStart(2, '0')}T12:00:00Z`,
    ...overrides,
  };
}

function commit(number, message = `Commit ${number}`) {
  return { sha: String(number).padStart(40, 'a'), commit: { message, author: { date: '2026-11-17T12:00:00Z' } } };
}

test('README is retrieved from trusted API path, normalized, hashed, bounded, and missing README returns null', async () => {
  const rawText = '\uFEFFHeading\r\nCafe\u0301';
  const content = Buffer.from(rawText).toString('base64');
  const mock = providerFetch((url) => {
    assert.equal(url.hostname, 'api.github.com');
    assert.equal(url.pathname, '/repos/owner/repo/readme');
    return new Response(JSON.stringify({ name: 'README.md', path: 'README.md', sha: 'a'.repeat(40), size: Buffer.byteLength(rawText), encoding: 'base64', content, download_url: 'https://attacker.example/payload' }), { status: 200 });
  });
  const readme = await getRepositoryReadme({ installationId, ownerLogin: 'owner', repositoryName: 'repo', config, fetchImpl: mock.fetchImpl });
  assert.equal(readme.text, 'Heading\nCafé');
  assert.equal(readme.contentHash, hashGitHubContent(readme.text));
  assert.equal(readme.revisionKey, createGitHubRevisionKey({ externalType: 'readme', externalId: 'README.md', upstreamRevision: 'a'.repeat(40), contentHash: readme.contentHash }));
  assert.equal(mock.requests.length, 2, 'provider-supplied download_url was never fetched');

  const missing = providerFetch((url) => url.pathname.endsWith('/readme')
    ? new Response('{}', { status: 404 })
    : new Response(JSON.stringify({ token: 'test-install-token', expires_at: '2026-11-17T12:00:00Z', permissions: { contents: 'read', issues: 'read' } }), { status: 201 }));
  assert.equal(await getRepositoryReadme({ installationId, ownerLogin: 'owner', repositoryName: 'repo', config, fetchImpl: missing.fetchImpl }), null);
});

test('README text is capped at 256 KiB with UTF-8-safe truncation', async () => {
  const text = '😀'.repeat(80_000);
  const response = { name: 'README.md', path: 'README.md', sha: 'b'.repeat(40), size: Buffer.byteLength(text), encoding: 'base64', content: Buffer.from(text).toString('base64') };
  const mock = providerFetch((url) => url.pathname.endsWith('/readme') ? new Response(JSON.stringify(response)) : tokenResponse());
  const result = await getRepositoryReadme({ installationId, ownerLogin: 'owner', repositoryName: 'repo', config, fetchImpl: mock.fetchImpl });
  assert.equal(result.truncated, true);
  assert.ok(result.contentBytes <= GITHUB_CONTENT_LIMITS.readmeItem);
  assert.equal(result.contentBytes % 4, 0);
  assert.doesNotThrow(() => new TextEncoder().encode(result.text));
});

test('commit retrieval requests and returns at most 50 messages without diff or patch endpoints', async () => {
  const mock = providerFetch((url) => {
    assert.equal(url.pathname, '/repos/owner/repo/commits');
    assert.equal(url.searchParams.get('per_page'), '50');
    return new Response(JSON.stringify(Array.from({ length: 50 }, (_, i) => commit(i + 1, `😀${'x'.repeat(9000)}`))));
  });
  const result = await getRecentRepositoryCommits({ installationId, ownerLogin: 'owner', repositoryName: 'repo', config, fetchImpl: mock.fetchImpl });
  assert.equal(result.length, 50);
  assert.ok(result.every((item) => item.truncated && item.contentBytes <= GITHUB_CONTENT_LIMITS.commitItem));
  assert.ok(result.reduce((sum, item) => sum + item.contentBytes, 0) <= GITHUB_CONTENT_LIMITS.commits);
  assert.ok(mock.requests.every(({ url }) => !/diff|patch/i.test(url.pathname)));
});

test('issue scan excludes pull requests, stops when exhausted, and respects page ceiling', async () => {
  const exhausted = providerFetch((url) => {
    assert.equal(url.searchParams.get('state'), 'all');
    assert.equal(url.searchParams.get('sort'), 'updated');
    assert.equal(url.searchParams.get('direction'), 'desc');
    assert.equal(url.searchParams.get('per_page'), '100');
    return new Response(JSON.stringify([issue(1), issue(2, { pull_request: { url: 'https://api.github.com/...' } }), issue(3)]));
  });
  const short = await listRecentRepositoryIssues({ installationId, ownerLogin: 'owner', repositoryName: 'repo', config, fetchImpl: exhausted.fetchImpl });
  assert.equal(short.issueCount, 2);
  assert.equal(short.pagesScanned, 1);
  assert.equal(short.complete, true);

  const capped = providerFetch((url) => {
    const page = Number(url.searchParams.get('page'));
    return new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => (i % 10 === 0 ? issue(page * 100 + i) : issue(page * 100 + i, { pull_request: {} })))));
  });
  const partial = await listRecentRepositoryIssues({ installationId, ownerLogin: 'owner', repositoryName: 'repo', config, fetchImpl: capped.fetchImpl });
  assert.equal(partial.pagesScanned, 5);
  assert.equal(partial.rawEntriesScanned, 500);
  assert.equal(partial.issueCount, 50);
  assert.equal(partial.complete, false);
  assert.equal(partial.partialReason, 'issue_scan_limit_reached');
  assert.equal(capped.requests.filter(({ url }) => url.pathname.endsWith('/issues')).length, 5);
});

test('issue scan stops at 100 qualifying entries and does not fetch an unnecessary page', async () => {
  const mock = providerFetch((url) => new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => issue(i + 1)))));
  const result = await listRecentRepositoryIssues({ installationId, ownerLogin: 'owner', repositoryName: 'repo', config, fetchImpl: mock.fetchImpl });
  assert.equal(result.issueCount, 100);
  assert.equal(result.pagesScanned, 1);
  assert.equal(result.complete, true);
});

test('content budget enforces per-item, category, and reusable aggregate limits', () => {
  const limits = createGitHubContentBudget();
  const first = limits.capture('commits', 'a'.repeat(GITHUB_CONTENT_LIMITS.commitItem + 1), GITHUB_CONTENT_LIMITS.commitItem);
  assert.equal(first.contentBytes, GITHUB_CONTENT_LIMITS.commitItem);
  for (let i = 0; i < 40; i += 1) limits.capture('commits', 'b'.repeat(GITHUB_CONTENT_LIMITS.commitItem), GITHUB_CONTENT_LIMITS.commitItem);
  assert.ok(limits.snapshot().categoryContentBytes.commits <= GITHUB_CONTENT_LIMITS.commits);

  const total = createGitHubContentBudget({ totalLimit: 10, categoryLimits: { readme: 20, commits: 20, issues: 20 } });
  total.capture('readme', '12345678', 20);
  const capped = total.capture('issues', 'abcdef', 20);
  assert.equal(capped.text, 'ab');
  assert.equal(total.snapshot().totalContentBytes, 10);

  const issueBudget = createGitHubContentBudget();
  const issueResult = issueBudget.captureRecord('issues', { title: 't'.repeat(10_000), body: 'b'.repeat(10_000) }, GITHUB_CONTENT_LIMITS.issueItem);
  assert.ok(issueResult.contentBytes <= GITHUB_CONTENT_LIMITS.issueItem);
  for (let i = 0; i < 100; i += 1) issueBudget.capture('issues', 'x'.repeat(GITHUB_CONTENT_LIMITS.issueItem), GITHUB_CONTENT_LIMITS.issueItem);
  assert.ok(issueBudget.snapshot().categoryContentBytes.issues <= GITHUB_CONTENT_LIMITS.issues);
});

test('normalization and stable revision keys are deterministic', () => {
  assert.equal(normalizeGitHubText('\uFEFFa\r\nb\rcafe\u0301'), 'a\nb\ncafé');
  assert.equal(hashGitHubContent('a\r\nb'), hashGitHubContent('a\nb'));
  const contentHash = hashGitHubContent('same');
  const key = createGitHubRevisionKey({ externalType: 'issue', externalId: '42', upstreamRevision: '2026-01-01', contentHash });
  assert.equal(key, createGitHubRevisionKey({ externalType: 'issue', externalId: '42', upstreamRevision: '2026-01-01', contentHash }));
  assert.notEqual(key, createGitHubRevisionKey({ externalType: 'issue', externalId: '42', upstreamRevision: '2026-01-02', contentHash }));
  assert.throws(() => createGitHubRevisionKey({ externalType: 'issue', externalId: '42', contentHash: 'bad' }), TypeError);
  assert.deepEqual(truncateUtf8('A😀B', 5), { text: 'A😀', byteLength: 5, truncated: true });
  assert.equal(utf8ByteLength('😀'), 4);
});

test('raw GitHub response limit is enforced from content-length and streaming bytes before JSON parsing', async () => {
  const tooLong = providerFetch((url) => url.pathname.endsWith('/readme')
    ? new Response('{}', { headers: { 'content-length': String(GITHUB_PROVIDER_LIMITS.rawResponseBytes + 1) } })
    : tokenResponse());
  await assert.rejects(getRepositoryReadme({ installationId, ownerLogin: 'owner', repositoryName: 'repo', config, fetchImpl: tooLong.fetchImpl }), { code: 'GITHUB_RESPONSE_TOO_LARGE' });

  const oversizedBody = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"padding":"'));
    controller.enqueue(new Uint8Array(GITHUB_PROVIDER_LIMITS.rawResponseBytes));
    controller.close();
  } });
  const streamed = providerFetch((url) => url.pathname.endsWith('/readme') ? new Response(oversizedBody) : tokenResponse());
  await assert.rejects(getRepositoryReadme({ installationId, ownerLogin: 'owner', repositoryName: 'repo', config, fetchImpl: streamed.fetchImpl }), { code: 'GITHUB_RESPONSE_TOO_LARGE' });

  const exact = { name: 'README.md', path: 'README.md', sha: 'c'.repeat(40), size: 2, encoding: 'base64', content: 'b2s=', padding: '' };
  const fixedSize = Buffer.byteLength(JSON.stringify(exact));
  exact.padding = 'x'.repeat(GITHUB_PROVIDER_LIMITS.rawResponseBytes - fixedSize);
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), GITHUB_PROVIDER_LIMITS.rawResponseBytes);
  const boundary = providerFetch((url) => url.pathname.endsWith('/readme') ? new Response(JSON.stringify(exact)) : tokenResponse());
  const boundaryResult = await getRepositoryReadme({ installationId, ownerLogin: 'owner', repositoryName: 'repo', config, fetchImpl: boundary.fetchImpl });
  assert.equal(boundaryResult.text, 'ok');
});

test('malformed JSON, invalid schemas, bad UTF-8, and malformed base64 fail closed', async () => {
  const malformed = providerFetch((url) => url.pathname.endsWith('/readme') ? new Response('{') : tokenResponse());
  await assert.rejects(getRepositoryReadme({ installationId, ownerLogin: 'owner', repositoryName: 'repo', config, fetchImpl: malformed.fetchImpl }), { code: 'GITHUB_INVALID_RESPONSE' });

  const badSchema = providerFetch((url) => url.pathname.endsWith('/commits') ? new Response(JSON.stringify([{ sha: 'bad', commit: { message: 'x' } }])) : tokenResponse());
  await assert.rejects(getRecentRepositoryCommits({ installationId, ownerLogin: 'owner', repositoryName: 'repo', config, fetchImpl: badSchema.fetchImpl }), { code: 'GITHUB_INVALID_RESPONSE' });

  const badBase64 = providerFetch((url) => url.pathname.endsWith('/readme') ? new Response(JSON.stringify({ name: 'README.md', path: 'README.md', sha: 'a'.repeat(40), size: 1, encoding: 'base64', content: '!!!!' })) : tokenResponse());
  await assert.rejects(getRepositoryReadme({ installationId, ownerLogin: 'owner', repositoryName: 'repo', config, fetchImpl: badBase64.fetchImpl }), { code: 'GITHUB_INVALID_RESPONSE' });

  const invalidUtf8 = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([0xc3, 0x28])); controller.close(); } });
  const badEncoding = providerFetch((url) => url.pathname.endsWith('/readme') ? new Response(invalidUtf8) : tokenResponse());
  await assert.rejects(getRepositoryReadme({ installationId, ownerLogin: 'owner', repositoryName: 'repo', config, fetchImpl: badEncoding.fetchImpl }), { code: 'GITHUB_INVALID_RESPONSE' });
});

test('provider auth, rate-limit, not-found, timeout, and network failures use safe codes', async () => {
  const cases = [
    [401, {}, 'GITHUB_AUTH_EXPIRED'],
    [403, { 'x-ratelimit-remaining': '0', 'retry-after': '30' }, 'GITHUB_RATE_LIMITED'],
    [403, { 'retry-after': '15' }, 'GITHUB_RATE_LIMITED'],
    [404, {}, 'GITHUB_RESOURCE_UNAVAILABLE'],
    [429, {}, 'GITHUB_RATE_LIMITED'],
  ];
  for (const [status, headers, code] of cases) {
    const mock = providerFetch((url) => url.pathname.endsWith('/commits') ? new Response('{"message":"token=DO_NOT_LEAK"}', { status, headers }) : tokenResponse());
    await assert.rejects(getRecentRepositoryCommits({ installationId, ownerLogin: 'owner', repositoryName: 'repo', config, fetchImpl: mock.fetchImpl }), (error) => {
      assert.ok(error instanceof GitHubApiError);
      assert.equal(error.code, code);
      assert.equal(error.message.includes('DO_NOT_LEAK'), false);
      assert.equal(JSON.stringify(error).includes('DO_NOT_LEAK'), false);
      return true;
    });
  }

  const resetFetch = providerFetch((url) => url.pathname.endsWith('/commits')
    ? new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 45) } })
    : tokenResponse());
  await assert.rejects(getRecentRepositoryCommits({ installationId, ownerLogin: 'owner', repositoryName: 'repo', config, fetchImpl: resetFetch.fetchImpl }), (error) => {
    assert.equal(error.code, 'GITHUB_RATE_LIMITED');
    assert.ok(Number(error.retryAfter) >= 1 && Number(error.retryAfter) <= 45);
    return true;
  });

  for (const failure of [Object.assign(new Error('sensitive timeout text'), { name: 'TimeoutError' }), Object.assign(new Error('socket'), { code: 'ETIMEDOUT' }), new Error('credential=hidden network failure')]) {
    const mock = providerFetch((url) => url.pathname.endsWith('/issues') ? Promise.reject(failure) : tokenResponse());
    await assert.rejects(listRecentRepositoryIssues({ installationId, ownerLogin: 'owner', repositoryName: 'repo', config, fetchImpl: mock.fetchImpl }), (error) => {
      assert.equal(error.code, failure.name === 'TimeoutError' || failure.code === 'ETIMEDOUT' ? 'GITHUB_TIMEOUT' : 'GITHUB_UNAVAILABLE');
      assert.equal(error.message.includes('hidden'), false);
      assert.equal(error.message.includes('sensitive'), false);
      return true;
    });
  }
});

test('OAuth token response is bounded before JSON parsing', async () => {
  const oversized = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"token":"'));
    controller.enqueue(new Uint8Array(GITHUB_PROVIDER_LIMITS.rawResponseBytes));
    controller.close();
  } });
  await assert.rejects(exchangeUserCode({ code: 'one-time', config, fetchImpl: async () => new Response(oversized) }), { code: 'GITHUB_RESPONSE_TOO_LARGE' });
});

test('provider request failures never include authorization tokens in errors or request paths', async () => {
  const mock = providerFetch((url, options) => {
    assert.equal(url.hostname, 'api.github.com');
    assert.equal(options.headers.authorization, 'Bearer test-install-token');
    return new Response(JSON.stringify({ message: 'Bearer test-install-token private payload' }), { status: 500 });
  });
  await assert.rejects(getRecentRepositoryCommits({ installationId, ownerLogin: 'owner', repositoryName: 'repo', config, fetchImpl: mock.fetchImpl }), (error) => {
    assert.equal(error.code, 'GITHUB_PROVIDER_ERROR');
    assert.equal(error.message.includes('test-install-token'), false);
    assert.equal(JSON.stringify(error).includes('private payload'), false);
    return true;
  });
});
