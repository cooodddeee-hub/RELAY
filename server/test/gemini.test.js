import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '@google/genai';
import { extractFindings, GeminiAnalysisError, CLOUDFLARE_MODEL, DEFAULT_ANALYSIS_PROVIDER } from '../src/services/gemini.js';
import { publicAnalysisJob, safeProviderAttempts } from '../src/services/analysisJobState.js';
import { errorDetails, logError, sanitizeLogText } from '../src/utils/safeLogger.js';

const source = { _id: 'source-test-id', originalName: 'handover.txt', extractedText: 'The team decided to ship the beta in June.' };
const response = { text: JSON.stringify({ findings: [{ category: 'Decision', title: 'Ship the beta in June', description: 'The team chose a June beta launch.', confidence: 0.9, quote: 'The team decided to ship the beta in June.', section: 'Launch plan' }] }) };
const failure = (status, message = 'temporary provider failure') => Object.assign(new Error(message), { status });

function clientFrom(responses, onCall = () => {}) {
  let calls = 0;
  return {
    get calls() { return calls; },
    models: { generateContent: async (request) => { calls += 1; onCall(request); const value = responses.shift(); if (value instanceof Error) throw value; return value; } },
  };
}

test('configures the SDK request timeout and disables its built-in retries', async () => {
  let configured;
  const result = await extractFindings(source, {
    primaryProvider: 'gemini',
    timeoutMs: 12_345,
    clientFactory: (config) => { configured = config; return clientFrom([response]); },
    sleep: async () => {},
  });
  assert.equal(configured.httpOptions.timeout, 12_345);
  assert.deepEqual(configured.httpOptions.retryOptions, { attempts: 1 });
  assert.equal(result.length, 1);
  assert.equal(result[0].evidence[0].quote, 'The team decided to ship the beta in June.');
  assert.equal(result[0].evidence[0].verificationStatus, 'verified');
  assert.equal(result[0].evidence[0].source, source._id);
  assert.equal(result[0].evidence[0].matchedText, source.extractedText);
});

test('AI evidence preserves the pinned immutable revision and provenance locator', async () => {
  const pinnedSource = {
    ...source,
    _analysisRevisionId: 'revision-immutable-1',
    _analysisRevisionLocator: { provider: 'github', externalType: 'issue', issueNumber: 17 },
  };
  const result = await extractFindings(pinnedSource, {
    primaryProvider: 'gemini', client: clientFrom([response]),
  });
  assert.equal(result[0].evidence[0].sourceRevision, 'revision-immutable-1');
  assert.deepEqual(result[0].evidence[0].locator, pinnedSource._analysisRevisionLocator);
  assert.equal(result[0].evidence[0].verificationStatus, 'verified');
});

test('analysis retains paraphrased quotes as unverified evidence with the original source association', async () => {
  const paraphrasedResponse = { text: JSON.stringify({ findings: [{ category: 'Decision', title: 'Beta timing', description: 'The beta was planned for summer.', quote: 'The beta is set for early summer.' }] }) };
  const result = await extractFindings(source, { primaryProvider: 'gemini', client: clientFrom([paraphrasedResponse]) });
  assert.equal(result[0].evidence[0].quote, 'The beta is set for early summer.');
  assert.equal(result[0].evidence[0].verificationStatus, 'unverified');
  assert.equal(result[0].evidence[0].source, source._id);
  assert.equal('matchedText' in result[0].evidence[0], false);
});

test('retries temporary 503 failures with exponential backoff then returns real findings', async () => {
  const client = clientFrom([failure(503), failure(503), response]);
  const delays = [];
  const result = await extractFindings(source, { primaryProvider: 'gemini', client, maxRetries: 2, sleep: async (delay) => delays.push(delay) });
  assert.equal(client.calls, 3);
  assert.deepEqual(delays, [500, 1000]);
  assert.equal(result[0].title, 'Ship the beta in June');
});

test('retries 429 rate limits and succeeds without inventing output', async () => {
  const client = clientFrom([failure(429, 'quota temporarily exhausted'), response]);
  const delays = [];
  const result = await extractFindings(source, { primaryProvider: 'gemini', client, maxRetries: 1, sleep: async (delay) => delays.push(delay) });
  assert.equal(client.calls, 2);
  assert.deepEqual(delays, [500]);
  assert.equal(result.length, 1);
});

test('exhausted Gemini timeouts invoke Cloudflare after the configured retry', async () => {
  const timeout = Object.assign(new Error('request timed out'), { name: 'APIConnectionTimeoutError' });
  const client = clientFrom([timeout, timeout]);
  const delays = [];
  let fallbackCalls = 0;
  const result = await extractFindings(source, {
    primaryProvider: 'gemini',
    client, maxRetries: 1, sleep: async (delay) => delays.push(delay),
    cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token',
    cloudflareFetch: async () => { fallbackCalls += 1; return cloudflareResponse(); },
  });
  assert.equal(client.calls, 2);
  assert.deepEqual(delays, [500]);
  assert.equal(fallbackCalls, 1);
  assert.equal(result[0].evidence[0].verificationStatus, 'verified');
});

test('does not retry permanent provider errors or fabricate findings', async () => {
  const client = clientFrom([failure(400, 'invalid request')]);
  await assert.rejects(
    extractFindings(source, { primaryProvider: 'gemini', client, maxRetries: 2, sleep: async () => assert.fail('permanent errors must not retry') }),
    (error) => error instanceof GeminiAnalysisError && error.status === 502,
  );
  assert.equal(client.calls, 1);
});

test('does not turn malformed provider output into findings', async () => {
  const client = clientFrom([{ text: 'not JSON' }]);
  await assert.rejects(
    extractFindings(source, { primaryProvider: 'gemini', client }),
    (error) => error instanceof GeminiAnalysisError && error.kind === 'invalid_response',
  );
  assert.equal(client.calls, 1);
});

test('rejects malformed finding field types from Gemini as a typed invalid response', async () => {
  const malformed = { text: JSON.stringify({ findings: [
    { category: 'Decision', title: 42, description: 'A valid description.' },
  ] }) };
  await assert.rejects(extractFindings(source, { primaryProvider: 'gemini', client: clientFrom([malformed]) }),
    (error) => error instanceof GeminiAnalysisError && error.kind === 'invalid_response');
});

test('rejects malformed optional field types from Cloudflare without returning partial findings', async () => {
  const valid = { category: 'Decision', title: 'Valid', description: 'Valid description.', quote: 'The team decided to ship the beta in June.' };
  const malformed = { category: 'Decision', title: 'Invalid', description: 'Invalid description.', confidence: 'high', quote: { text: 'fake' } };
  await assert.rejects(extractFindings(source, {
    primaryProvider: 'cloudflare',
    cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token',
    cloudflareFetch: async () => ({ ok: true, status: 200, json: async () => ({ success: true, result: { response: JSON.stringify({ findings: [valid, malformed] }) } }) }),
  }), (error) => error instanceof GeminiAnalysisError && error.kind === 'invalid_response');
});

test('malformed Gemini output does not trigger Cloudflare fallback', async () => {
  let fallbackCalls = 0;
  await assert.rejects(extractFindings(source, {
    primaryProvider: 'gemini',
    client: clientFrom([{ text: 'not JSON' }]),
    cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token',
    cloudflareFetch: async () => { fallbackCalls += 1; return cloudflareResponse(); },
  }), (error) => error instanceof GeminiAnalysisError && error.kind === 'invalid_response');
  assert.equal(fallbackCalls, 0);
});

test('Gemini output with unverified evidence does not trigger a fallback provider', async () => {
  let fallbackCalls = 0;
  const unverifiedResponse = { text: JSON.stringify({ findings: [{
    category: 'Decision', title: 'Unsupported decision', description: 'This quote is not in the source.', quote: 'An invented quotation.',
  }] }) };
  const findings = await extractFindings(source, {
    primaryProvider: 'gemini',
    client: clientFrom([unverifiedResponse]),
    cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token',
    cloudflareFetch: async () => { fallbackCalls += 1; return cloudflareResponse(); },
  });
  assert.equal(fallbackCalls, 0);
  assert.equal(findings[0].evidence[0].verificationStatus, 'unverified');
});

test('sanitizes credentials and request tokens before error logging', () => {
  const value = 'API_KEY=AIzaSyAbcdefghijklmnopqrstuvwxyz012345 eyJabcdefghij.klmnopqrst.uvwxyz12345 Bearer sensitive-token\nauthorization: Bearer header-token\ncookie: sid=cookie-secret; jwt=another-secret\nmongodb+srv://user:pass@host/db';
  const safe = sanitizeLogText(value);
  assert.doesNotMatch(safe, /AIzaSy|eyJabcdefghij|user:pass|header-token|cookie-secret|another-secret/);
  assert.match(safe, /REDACTED_API_KEY/);
  assert.match(safe, /REDACTED_JWT/);
  assert.match(safe, /REDACTED_MONGODB_URI/);
});

test('safe logger omits raw provider/database error messages, stacks and unapproved metadata', () => {
  const privateText = 'private issue body Bearer token-value';
  const error = Object.assign(new Error(privateText), { code: 'ECONNRESET' });
  error.stack = `Error: ${privateText}`;
  assert.deepEqual(errorDetails(error), { name: 'Error', code: 'ECONNRESET' });
  const original = console.error; let output = '';
  try {
    console.error = (value) => { output = value; };
    logError('provider.request', error, { projectId: '012345678901234567890123', body: privateText, token: 'secret' });
  } finally { console.error = original; }
  assert.match(output, /projectId/);
  assert.doesNotMatch(output, /private issue|token-value|secret/);
});

function cloudflareResponse(findings = [{ category: 'Decision', title: 'Ship the beta', description: 'The source says the beta will ship in June.', confidence: 0.9, quote: 'The team decided to ship the beta in June.' }]) {
  return { ok: true, status: 200, json: async () => ({ success: true, result: { response: JSON.stringify({ findings }) } }) };
}

test('Cloudflare is the default primary and succeeds without calling Gemini', async () => {
  let geminiCalls = 0;
  const result = await extractFindings(source, {
    cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token',
    cloudflareFetch: async () => cloudflareResponse(),
    client: { models: { generateContent: async () => { geminiCalls += 1; return response; } } },
  });
  assert.equal(result.length, 1);
  assert.equal(geminiCalls, 0);
  assert.deepEqual(result.providerAttempts, [
    { provider: 'cloudflare', role: 'primary', outcome: 'success', category: 'success', errorCode: 'none' },
  ]);
});

test('SDK ApiError wrapped as a cause is retried and then invokes Cloudflare', async () => {
  const wrapped503 = () => Object.assign(new Error('provider request failed'), {
    cause: new ApiError({ status: 503, message: 'upstream unavailable' }),
  });
  const client = clientFrom([wrapped503(), wrapped503(), wrapped503()]);
  const delays = [];
  let fallbackCalls = 0;
  const result = await extractFindings(source, {
    primaryProvider: 'gemini',
    client, maxRetries: 2, sleep: async (delay) => delays.push(delay),
    cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token', cloudflareMaxRetries: 0,
    cloudflareFetch: async () => { fallbackCalls += 1; return cloudflareResponse(); },
  });
  assert.equal(client.calls, 3);
  assert.deepEqual(delays, [500, 1000]);
  assert.equal(fallbackCalls, 1);
  assert.deepEqual(result.providerAttempts.map(({ provider, outcome, status, category }) => ({ provider, outcome, status, category })), [
    { provider: 'gemini', outcome: 'temporary_failure', status: 503, category: 'http' },
    { provider: 'gemini', outcome: 'temporary_failure', status: 503, category: 'http' },
    { provider: 'gemini', outcome: 'temporary_failure', status: 503, category: 'http' },
    { provider: 'cloudflare', outcome: 'success', status: undefined, category: 'success' },
  ]);
  assert.equal(result[0].evidence[0].verificationStatus, 'verified');
  assert.equal(result[0].evidence[0].source, source._id);
});

test('Cloudflare primary success metadata passes the persistence sanitizer and public status projection', async () => {
  const findings = await extractFindings(source, {
    cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token', cloudflareMaxRetries: 0,
    cloudflareFetch: async () => cloudflareResponse(),
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].evidence[0].verificationStatus, 'verified');
  assert.equal(findings[0].evidence[0].source, source._id);
  const jobStatus = publicAnalysisJob({
    status: 'completed',
    lastProviderAttempts: safeProviderAttempts(findings.providerAttempts),
  });
  assert.deepEqual(jobStatus.lastProviderAttempts.map(({ provider, role, outcome }) => ({ provider, role, outcome })), [
    { provider: 'cloudflare', role: 'primary', outcome: 'success' },
  ]);
  assert.equal(jobStatus.demoFallbackAvailable, false);
});

test('installed SDK APIConnectionTimeoutError shape is retryable through its dedicated name', async () => {
  const timeout = Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' });
  const client = clientFrom([timeout, timeout]);
  let fallbackCalls = 0;
  const result = await extractFindings(source, {
    primaryProvider: 'gemini',
    client, maxRetries: 1, sleep: async () => {}, cloudflareMaxRetries: 0,
    cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token',
    cloudflareFetch: async () => { fallbackCalls += 1; return cloudflareResponse(); },
  });
  assert.equal(client.calls, 2);
  assert.equal(fallbackCalls, 1);
  assert.equal(result.providerAttempts[0].category, 'timeout');
  assert.equal(result.providerAttempts[1].category, 'timeout');
});

test('SDK APIUserAbortError is a cancellation and never invokes Cloudflare', async () => {
  const userAbort = Object.assign(new Error('The user aborted the request.'), { name: 'APIUserAbortError' });
  let fallbackCalls = 0;
  const client = clientFrom([userAbort]);
  await assert.rejects(extractFindings(source, {
    primaryProvider: 'gemini',
    client, maxRetries: 2,
    cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token',
    cloudflareFetch: async () => { fallbackCalls += 1; return cloudflareResponse(); },
  }), (error) => error instanceof GeminiAnalysisError && error.retryable === false && error.kind === 'provider');
  assert.equal(client.calls, 1);
  assert.equal(fallbackCalls, 0);
});

test('Cloudflare is configured with the validated model and is the default primary provider', () => {
  assert.equal(CLOUDFLARE_MODEL, '@cf/openai/gpt-oss-20b');
  assert.equal(DEFAULT_ANALYSIS_PROVIDER, 'cloudflare');
});

test('Cloudflare primary validates schema, exact evidence, and source association', async () => {
  let request;
  const result = await extractFindings(source, {
    cloudflareAccountId: 'test-account',
    cloudflareApiToken: 'test-token',
    cloudflareMaxRetries: 0,
    cloudflareFetch: async (url, options) => {
      request = { url, options };
      return cloudflareResponse();
    },
    client: clientFrom([failure(503)]),
  });
  assert.match(request.url, new RegExp('/ai/run/' + CLOUDFLARE_MODEL.replaceAll('/', '\\/').replaceAll('.', '\\.') + '$'));
  assert.equal(request.options.headers.Authorization, 'Bearer test-token');
  assert.equal(JSON.parse(request.options.body).max_tokens, 2048);
  assert.equal(JSON.parse(request.options.body).reasoning_effort, 'low');
  assert.equal(JSON.parse(request.options.body).temperature, 0);
  assert.equal(result.length, 1);
  assert.equal(result[0].evidence[0].source, source._id);
  assert.equal(result[0].evidence[0].verificationStatus, 'verified');
  assert.equal(result[0].evidence[0].matchedText, source.extractedText);
});

test('Gemini bounded retries exhaust before Cloudflare fallback failure and preserve all attempts', async () => {
  let geminiCalls = 0;
  let cloudflareCalls = 0;
  const delays = [];
  const geminiTemporaryFailure = Object.assign(new Error('temporary provider failure'), { status: 503 });
  await assert.rejects(extractFindings(source, {
    primaryProvider: 'gemini',
    client: { models: { generateContent: async () => { geminiCalls += 1; throw geminiTemporaryFailure; } } },
    maxRetries: 1,
    cloudflareAccountId: 'test-account',
    cloudflareApiToken: 'test-token',
    cloudflareMaxRetries: 1,
    cloudflareFetch: async () => { cloudflareCalls += 1; return { ok: false, status: 503 }; },
    sleep: async (delay) => delays.push(delay),
  }), (error) => {
    assert.equal(error.provider, 'cloudflare');
    assert.equal(error.retryable, true);
    assert.deepEqual(error.providerAttempts.map(({ provider, outcome, status }) => ({ provider, outcome, status })), [
      { provider: 'gemini', outcome: 'temporary_failure', status: 503 },
      { provider: 'gemini', outcome: 'temporary_failure', status: 503 },
      { provider: 'cloudflare', outcome: 'temporary_failure', status: 503 },
      { provider: 'cloudflare', outcome: 'temporary_failure', status: 503 },
    ]);
    return true;
  });
  assert.equal(geminiCalls, 2);
  assert.equal(cloudflareCalls, 2);
  assert.deepEqual(delays, [500, 500]);
});

test('provider diagnostics report timing and fallback state without source text or credentials', async () => {
  const diagnostics = [];
  const originalInfo = console.info;
  console.info = (line) => diagnostics.push(JSON.parse(line));
  try {
    await extractFindings(source, {
      primaryProvider: 'cloudflare',
      cloudflareAccountId: 'test-account',
      cloudflareApiToken: 'test-token',
      cloudflareMaxRetries: 0,
      cloudflareFetch: async () => cloudflareResponse(),
    });
  } finally {
    console.info = originalInfo;
  }
  const requestEvents = diagnostics.filter((event) => event.operation === 'analysis.providerRequest' && event.provider === 'cloudflare');
  assert.equal(requestEvents.some((event) => event.phase === 'started' && event.fallbackOccurred === false), true);
  assert.equal(requestEvents.some((event) => event.phase === 'completed' && event.success === true && Number.isFinite(event.durationMs)), true);
  const serialized = JSON.stringify(diagnostics);
  assert.equal(serialized.includes(source.extractedText), false);
  assert.equal(serialized.includes('test-token'), false);
  assert.equal(serialized.includes('test-account'), false);
});

test('provider failure diagnostics include safe error classes, recognized codes, status, and bounded wrapper path', async () => {
  const diagnostics = [];
  const originalInfo = console.info;
  console.info = (line) => diagnostics.push(JSON.parse(line));
  const cause = Object.assign(new ApiError({ status: 502, message: 'sensitive upstream detail' }), { code: 'ECONNRESET' });
  try {
    await assert.rejects(extractFindings(source, {
    primaryProvider: 'gemini',
      client: clientFrom([Object.assign(new Error('private outer message'), { cause })]),
      maxRetries: 0,
      cloudflareAccountId: 'test-account',
      cloudflareApiToken: 'test-token',
      cloudflareFetch: async () => { throw new Error('should not fall back for unknown wrapper'); },
    }));
  } finally {
    console.info = originalInfo;
  }
  const failedEvent = diagnostics.find((event) => event.operation === 'analysis.providerRequest' && event.phase === 'completed' && event.success === false);
  assert.equal(failedEvent.errorClass, 'Error');
  assert.deepEqual(failedEvent.wrapperChain, [
    { via: 'root', errorClass: 'Error' },
    { via: 'cause', errorClass: 'ApiError', errorCode: 'ECONNRESET', httpStatus: 502 },
  ]);
  assert.equal(JSON.stringify(diagnostics).includes('sensitive upstream detail'), false);
  assert.equal(JSON.stringify(diagnostics).includes('private outer message'), false);
  assert.equal(JSON.stringify(diagnostics).includes('test-token'), false);
});

test('Cloudflare rejects fabricated evidence without falling back to Gemini', async () => {
  let geminiCalls = 0;
  await assert.rejects(extractFindings(source, {
    primaryProvider: 'cloudflare',
    cloudflareAccountId: 'test-account',
    cloudflareApiToken: 'test-token',
    cloudflareMaxRetries: 0,
    cloudflareFetch: async () => cloudflareResponse([{ category: 'Decision', title: 'Invented', description: 'Unsupported.', quote: 'The team chose a November release.' }]),
    client: { models: { generateContent: async () => { geminiCalls += 1; return response; } } },
  }), (error) => error instanceof GeminiAnalysisError && error.kind === 'invalid_response' && /verified against the source/.test(error.message));
  assert.equal(geminiCalls, 0);
});

test('Cloudflare retries temporary errors and falls back to Gemini after exhaustion', async () => {
  let cloudflareCalls = 0;
  const delays = [];
  const result = await extractFindings(source, {
    cloudflareAccountId: 'test-account',
    cloudflareApiToken: 'test-token',
    cloudflareMaxRetries: 1,
    cloudflareFetch: async () => { cloudflareCalls += 1; return { ok: false, status: 503 }; },
    client: clientFrom([response]),
    maxRetries: 0,
    sleep: async (delay) => delays.push(delay),
  });
  assert.equal(cloudflareCalls, 2);
  assert.deepEqual(delays, [500]);
  assert.equal(result[0].evidence[0].source, source._id);
  assert.deepEqual(result.providerAttempts.map(({ provider, role }) => ({ provider, role })), [
    { provider: 'cloudflare', role: 'primary' },
    { provider: 'cloudflare', role: 'primary' },
    { provider: 'gemini', role: 'secondary' },
  ]);
});

test('Cloudflare authentication and permanent response failures do not fall back', async () => {
  let geminiCalls = 0;
  await assert.rejects(extractFindings(source, {
    cloudflareAccountId: 'test-account',
    cloudflareApiToken: 'test-token',
    cloudflareMaxRetries: 2,
    cloudflareFetch: async () => ({ ok: false, status: 401 }),
    client: { models: { generateContent: async () => { geminiCalls += 1; return response; } } },
  }), (error) => error instanceof GeminiAnalysisError && error.provider === 'cloudflare');
  assert.equal(geminiCalls, 0);
});

for (const status of [408, 429, 500, 502, 503, 504]) {
  test(`Gemini ${status} exhaustion invokes Cloudflare and returns verified findings`, async () => {
    let request;
    const result = await extractFindings(source, {
      client: clientFrom([failure(status)]), maxRetries: 0,
      cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token',
      cloudflareFetch: async (url, options) => { request = { url, options }; return cloudflareResponse(); },
    });
    assert.ok(request.url.endsWith('/ai/run/' + CLOUDFLARE_MODEL));
    assert.equal(request.options.headers.Authorization, 'Bearer test-token');
    assert.match(JSON.parse(request.options.body).messages[0].content, /The team decided to ship the beta in June\./);
    assert.equal(result[0].evidence[0].verificationStatus, 'verified');
    assert.equal(result[0].evidence[0].source, source._id);
  });
}

for (const status of [401, 403]) {
  test(`Gemini HTTP ${status} authentication/permission failures do not invoke Cloudflare`, async () => {
    let fallbackCalls = 0;
    await assert.rejects(extractFindings(source, {
      primaryProvider: 'gemini', client: clientFrom([failure(status, 'auth or permission failure')]), maxRetries: 0,
      cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token',
      cloudflareFetch: async () => { fallbackCalls += 1; return cloudflareResponse(); },
    }), (error) => error instanceof GeminiAnalysisError && error.providerStatus === status);
    assert.equal(fallbackCalls, 0);
  });
}

test('Gemini network failures invoke Cloudflare after retry budget', async () => {
  const networkError = Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
  let fallbackCalls = 0;
  const delays = [];
  const client = clientFrom([networkError, networkError]);
  const result = await extractFindings(source, {
    primaryProvider: 'gemini', client, maxRetries: 1, sleep: async (delay) => delays.push(delay),
    cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token',
    cloudflareFetch: async () => { fallbackCalls += 1; return cloudflareResponse(); },
  });
  assert.equal(client.calls, 2);
  assert.deepEqual(delays, [500]);
  assert.equal(fallbackCalls, 1);
  assert.equal(result[0].evidence[0].verificationStatus, 'verified');
});

test('unclassified Gemini application errors do not invoke Cloudflare', async () => {
  let fallbackCalls = 0;
  await assert.rejects(extractFindings(source, {
    primaryProvider: 'gemini', client: clientFrom([new TypeError('unexpected application failure')]), maxRetries: 0,
    cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token',
    cloudflareFetch: async () => { fallbackCalls += 1; return cloudflareResponse(); },
  }), (error) => error instanceof GeminiAnalysisError && error.provider === 'gemini');
  assert.equal(fallbackCalls, 0);
});

test('an unrelated Gemini error mentioning network is not retried or sent to Cloudflare', async () => {
  let fallbackCalls = 0;
  const client = clientFrom([new Error('network field validation failed')]);
  await assert.rejects(extractFindings(source, {
    primaryProvider: 'gemini', client, maxRetries: 2,
    cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token',
    cloudflareFetch: async () => { fallbackCalls += 1; return cloudflareResponse(); },
  }), (error) => error instanceof GeminiAnalysisError && error.retryable === false && error.kind === 'provider');
  assert.equal(client.calls, 1);
  assert.equal(fallbackCalls, 0);
});

test('Cloudflare provider errors are sanitized and surfaced', async () => {
  await assert.rejects(extractFindings(source, {
    client: clientFrom([failure(503)]), maxRetries: 0,
    cloudflareMaxRetries: 0,
    cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token',
    cloudflareFetch: async () => ({ ok: false, status: 500, json: async () => ({ errors: [{ message: 'private provider detail' }] }) }),
  }), (error) => error instanceof GeminiAnalysisError && error.status === 503 && !error.message.includes('private provider detail'));
});

test('Cloudflare exhausted temporary attempts invoke Gemini and preserve both providers metadata', async () => {
  await assert.rejects(extractFindings(source, {
    client: clientFrom([failure(503)]), maxRetries: 0, cloudflareMaxRetries: 1,
    cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token',
    cloudflareFetch: async () => ({ ok: false, status: 503 }),
    sleep: async () => {},
  }), (error) => {
    assert.deepEqual(error.providerAttempts.map(({ provider, outcome, status, category, errorCode }) => ({ provider, outcome, status, category, errorCode })), [
      { provider: 'cloudflare', outcome: 'temporary_failure', status: 503, category: 'http', errorCode: 'http_error' },
      { provider: 'cloudflare', outcome: 'temporary_failure', status: 503, category: 'http', errorCode: 'http_error' },
      { provider: 'gemini', outcome: 'temporary_failure', status: 503, category: 'http', errorCode: 'http_error' },
    ]);
    assert.equal(error.kind, 'provider');
    assert.equal(error.retryable, true);
    assert.equal(JSON.stringify(error.providerAttempts).includes(source.extractedText), false);
    return true;
  });
});

test('Cloudflare and eligible Gemini temporary failures carry primary/secondary metadata', async () => {
  await assert.rejects(extractFindings(source, {
    client: clientFrom([failure(503)]), maxRetries: 0,
    cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token', cloudflareMaxRetries: 0,
    cloudflareFetch: async () => ({ ok: false, status: 503 }),
  }), (error) => {
    assert.deepEqual(error.providerAttempts, [
      { provider: 'cloudflare', role: 'primary', outcome: 'temporary_failure', status: 503, category: 'http', errorCode: 'http_error' },
      { provider: 'gemini', role: 'secondary', outcome: 'temporary_failure', status: 503, category: 'http', errorCode: 'http_error' },
    ]);
    assert.equal(JSON.stringify(error.providerAttempts).includes(source.extractedText), false);
    assert.equal(JSON.stringify(error.providerAttempts).includes('test-token'), false);
    return error instanceof GeminiAnalysisError && error.kind === 'provider';
  });
});

test('a permanent Cloudflare primary failure is recorded and does not invoke Gemini', async () => {
  await assert.rejects(extractFindings(source, {
    cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token', cloudflareMaxRetries: 0,
    cloudflareFetch: async () => ({ ok: false, status: 401 }),
  }), (error) => {
    assert.deepEqual(error.providerAttempts, [
      { provider: 'cloudflare', role: 'primary', outcome: 'permanent_failure', status: 401, category: 'http', errorCode: 'http_error' },
    ]);
    return error instanceof GeminiAnalysisError && error.kind === 'provider';
  });
});

test('a wrapped Gemini authentication failure does not retry or invoke Cloudflare', async () => {
  let fallbackCalls = 0;
  const wrapped401 = Object.assign(new Error('request failed'), { cause: { error: { status: 401 } } });
  const client = clientFrom([wrapped401]);
  await assert.rejects(extractFindings(source, {
    primaryProvider: 'gemini',
    client, maxRetries: 2, cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token',
    cloudflareFetch: async () => { fallbackCalls += 1; return cloudflareResponse(); },
  }), (error) => error instanceof GeminiAnalysisError && error.providerStatus === 401 && error.retryable === false);
  assert.equal(client.calls, 1);
  assert.equal(fallbackCalls, 0);
});

test('Gemini client configuration errors do not invoke Cloudflare', async () => {
  let fallbackCalls = 0;
  await assert.rejects(extractFindings(source, {
    primaryProvider: 'gemini',
    clientFactory: () => { throw new Error('invalid local SDK configuration'); },
    cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token',
    cloudflareFetch: async () => { fallbackCalls += 1; return cloudflareResponse(); },
  }), (error) => error instanceof GeminiAnalysisError && error.kind === 'configuration'
    && error.providerAttempts[0].outcome === 'configuration_failure');
  assert.equal(fallbackCalls, 0);
});

test('Cloudflare malformed output is rejected', async () => {
  await assert.rejects(extractFindings(source, {
    client: clientFrom([failure(503)]), maxRetries: 0,
    cloudflareMaxRetries: 0,
    cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token',
    cloudflareFetch: async () => ({ ok: true, status: 200, json: async () => ({ success: true, result: { response: 'not JSON' } }) }),
  }), (error) => error instanceof GeminiAnalysisError && error.kind === 'invalid_response');
});

test('accepts Cloudflare structured findings objects and applies strict evidence validation', async () => {
  const findings = [{ category: 'Decision', title: 'Ship the beta', description: 'The team chose a June beta launch.', quote: 'The team decided to ship the beta in June.' }];
  const result = await extractFindings(source, {
    client: clientFrom([failure(503)]), maxRetries: 0,
    cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token',
    cloudflareFetch: async () => ({ ok: true, status: 200, json: async () => ({ success: true, result: { response: { findings } } }) }),
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].evidence[0].verificationStatus, 'verified');
  assert.equal(result[0].evidence[0].source, source._id);
});

test('accepts the OpenAI-compatible Cloudflare choices response envelope', async () => {
  const findings = [{ category: 'Decision', title: 'Ship the beta', description: 'The team chose a June beta launch.', confidence: 0.9, quote: 'The team decided to ship the beta in June.' }];
  const result = await extractFindings(source, {
    primaryProvider: 'cloudflare',
    cloudflareAccountId: 'test-account',
    cloudflareApiToken: 'test-token',
    cloudflareMaxRetries: 0,
    cloudflareFetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { choices: [{ message: { content: JSON.stringify({ findings }) } }] } }),
    }),
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].evidence[0].source, source._id);
  assert.equal(result[0].evidence[0].verificationStatus, 'verified');
});

test('Cloudflare prompt requires findings: [] for empty, short, or unsupported GitHub commit content', async (t) => {
  const cases = [
    ['empty commit', ''],
    ['very short commit', 'init'],
  ];
  for (const [name, text] of cases) {
    await t.test(name, async () => {
      let prompt = '';
      let geminiCalls = 0;
      const result = await extractFindings({
        ...source, provider: 'github', externalType: 'commit', originalName: 'Commit abcdef012345', extractedText: text,
      }, {
        cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token', cloudflareMaxRetries: 0,
        cloudflareFetch: async (_url, request) => {
          prompt = JSON.parse(request.body).messages[0].content;
          return cloudflareResponse([]);
        },
        client: { models: { generateContent: async () => { geminiCalls += 1; return response; } } },
      });
      assert.deepEqual(result, []);
      assert.match(prompt, /Evidence quotations must be exact, contiguous text copied from the source/);
      assert.match(prompt, /Preserve original wording, casing, and punctuation exactly/);
      assert.match(prompt, /Never paraphrase, rewrite, summarize, normalize, or invent evidence/);
      assert.match(prompt, /If you cannot provide an exact supporting quotation, omit that finding/);
      assert.match(prompt, /Always include the "findings" property and make its value an array/);
      assert.match(prompt, /If the source is empty, very short, or contains no supported findings, return exactly \{"findings":\[\]\}/);
      assert.equal(geminiCalls, 0);
      assert.equal(result.providerAttempts[0].provider, 'cloudflare');
    });
  }
});

test('a non-array findings value is rejected at the findings-array stage', async () => {
  const output = JSON.stringify({ findings: 'none' });
  await assert.rejects(extractFindings(source, {
    cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token', cloudflareMaxRetries: 0,
    cloudflareFetch: async () => ({ ok: true, status: 200, json: async () => ({ success: true, result: { response: output } }) }),
  }), (error) => error instanceof GeminiAnalysisError
    && error.validationDiagnostic?.validationStage === 'findings_array'
    && error.validationDiagnostic?.failureCode === 'missing_findings_array');
});

test('truncated Cloudflare JSON is rejected without falling back to Gemini', async () => {
  let geminiCalls = 0;
  await assert.rejects(extractFindings(source, {
    cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token', cloudflareMaxRetries: 0,
    cloudflareFetch: async () => ({ ok: true, status: 200, json: async () => ({ success: true, result: { response: '{"findings":[{"category":"Decision"' } }) }),
    client: { models: { generateContent: async () => { geminiCalls += 1; return response; } } },
  }), (error) => error instanceof GeminiAnalysisError
    && error.validationDiagnostic?.validationStage === 'model_json'
    && error.validationDiagnostic?.failureCode === 'invalid_json');
  assert.equal(geminiCalls, 0);
});

test('Cloudflare choices marked finish_reason length are diagnosed as incomplete before parsing', async () => {
  await assert.rejects(extractFindings(source, {
    cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token', cloudflareMaxRetries: 0,
    cloudflareFetch: async () => ({ ok: true, status: 200, json: async () => ({
      success: true, result: { choices: [{ finish_reason: 'length', message: { content: '{"summary":"cut off"}' } }] },
    }) }),
  }), (error) => error instanceof GeminiAnalysisError
    && error.validationDiagnostic?.validationStage === 'provider_envelope'
    && error.validationDiagnostic?.failureCode === 'incomplete_provider_response');
});

test('does not treat truncated reasoning-only Cloudflare output as finding content', async () => {
  const findings = [{ category: 'Decision', title: 'Ship the beta', description: 'The team chose a June beta launch.', quote: 'The team decided to ship the beta in June.' }];
  await assert.rejects(extractFindings(source, {
    primaryProvider: 'cloudflare',
    cloudflareAccountId: 'test-account',
    cloudflareApiToken: 'test-token',
    cloudflareMaxRetries: 0,
    cloudflareFetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: { choices: [{ finish_reason: 'length', message: { content: null, reasoning_content: JSON.stringify({ findings }) } }] },
      }),
    }),
  }), (error) => error instanceof GeminiAnalysisError && error.kind === 'invalid_response');
});

test('Cloudflare findings with unsupported evidence are rejected instead of accepted as unverified', async () => {
  await assert.rejects(extractFindings(source, {
    client: clientFrom([failure(503)]), maxRetries: 0,
    cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token',
    cloudflareFetch: async () => cloudflareResponse([{ category: 'Decision', title: 'Invented fact', description: 'Not in source.', quote: 'The team selected a launch date of August.' }]),
  }), (error) => error instanceof GeminiAnalysisError && error.kind === 'invalid_response' && /verified against the source/.test(error.message));
});

test('Cloudflare case and punctuation near-matches remain invalid and do not trigger Gemini', async (t) => {
  for (const [label, quote, expectedFlag] of [
    ['case-only', 'the team decided to ship the beta in June.', 'caseOnlyMatch'],
    ['punctuation-only', 'The team decided to ship the beta in June!', 'punctuationOnlyMatch'],
  ]) {
    await t.test(label, async () => {
      let geminiCalls = 0;
      await assert.rejects(extractFindings(source, {
        cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token', cloudflareMaxRetries: 0,
        cloudflareFetch: async () => cloudflareResponse([{ category: 'Decision', title: 'Beta decision', description: 'A proposed finding.', quote }]),
        client: { models: { generateContent: async () => { geminiCalls += 1; return response; } } },
      }), (error) => error instanceof GeminiAnalysisError
        && error.kind === 'invalid_response'
        && error.validationDiagnostic?.failureCode === 'evidence_quote_mismatch'
        && error.validationDiagnostic?.quoteMatchDiagnostics?.[expectedFlag] === true);
      assert.equal(geminiCalls, 0);
    });
  }
});

test('Cloudflare validation failures emit reason-specific safe diagnostics for every validation stage', async (t) => {
  const privateText = 'PRIVATE SOURCE TEXT: plan-alpha';
  const privateQuote = 'PRIVATE QUOTE: alpha decision';
  const diagnosticSource = {
    _id: '507f1f77bcf86cd799439011', provider: 'github', externalType: 'issue',
    originalName: 'private-issue-title', extractedText: `${privateText} ${privateQuote}`,
    _analysisRevisionId: '507f1f77bcf86cd799439012',
  };
  const validFinding = { category: 'Decision', title: 'Private finding title', description: 'Private finding description.', quote: privateQuote };
  const cases = [
    ['invalid_json', 'model_json', { success: true, result: { response: '{broken json' } }],
    ['invalid_response_envelope', 'provider_envelope', { success: false, result: { response: 'private output' } }],
    ['missing_findings_array', 'findings_array', { success: true, result: { response: JSON.stringify({ summary: 'private summary' }) } }],
    ['invalid_finding_schema', 'finding_schema', { success: true, result: { response: JSON.stringify({ findings: [{ ...validFinding, category: 'private invalid category' }] }) } }],
    ['missing_evidence', 'evidence_verification', { success: true, result: { response: JSON.stringify({ findings: [{ ...validFinding, quote: '' }] }) } }],
    ['evidence_quote_mismatch', 'evidence_verification', { success: true, result: { response: JSON.stringify({ findings: [{ ...validFinding, quote: 'fabricated private quote' }] }) } }],
    ['unsupported_evidence_reference', 'evidence_reference', { success: true, result: { response: JSON.stringify({ findings: [{ ...validFinding, sourceId: '507f1f77bcf86cd799439099' }] }) } }],
    ['incomplete_provider_response', 'provider_envelope', { success: true, result: { response: null } }],
  ];

  for (const [failureCode, validationStage, payload] of cases) {
    await t.test(failureCode, async () => {
      const logs = [];
      const originalInfo = console.info;
      console.info = (line) => logs.push(JSON.parse(line));
      let error;
      try {
        await assert.rejects(extractFindings(diagnosticSource, {
          diagnosticContext: { sourceId: diagnosticSource._id, sourceType: 'issue', sourcePosition: 3 },
          cloudflareAccountId: 'private-account-id', cloudflareApiToken: 'private-api-token',
          cloudflareMaxRetries: 0,
          cloudflareFetch: async () => ({ ok: true, status: 200, json: async () => payload }),
          client: { models: { generateContent: async () => { throw new Error('Gemini fallback must not run for invalid output'); } } },
        }), (caught) => {
          error = caught;
          return caught instanceof GeminiAnalysisError && caught.kind === 'invalid_response';
        });
      } finally {
        console.info = originalInfo;
      }
      const event = logs.find((entry) => entry.phase === 'validationFailed');
      assert.ok(event);
      assert.equal(event.provider, 'cloudflare');
      assert.equal(event.sourceType, 'issue');
      assert.equal(event.sourcePosition, 3);
      assert.equal(event.sourceId, diagnosticSource._id);
      assert.equal(event.validationStage, validationStage);
      assert.equal(event.failureCode, failureCode);
      assert.deepEqual(error.validationDiagnostic, {
        provider: 'cloudflare', sourceType: 'issue', sourcePosition: 3, sourceId: diagnosticSource._id,
        validationStage, failureCode,
        ...(failureCode === 'evidence_quote_mismatch' ? { quoteMatchDiagnostics: {
          exactQuoteMatch: false, caseOnlyMatch: false, punctuationOnlyMatch: false, unicodeNormalizationMatch: false,
        } } : {}),
      });
      const serialized = JSON.stringify(logs);
      for (const sensitiveValue of [privateText, privateQuote, 'private-issue-title', 'Private finding title', 'private summary', 'fabricated private quote', 'private-account-id', 'private-api-token']) {
        assert.equal(serialized.includes(sensitiveValue), false, `diagnostic leaked ${sensitiveValue}`);
      }
      assert.equal(serialized.includes('stack'), false);
      if (failureCode === 'evidence_quote_mismatch') {
        assert.equal(typeof event.quoteMatchDiagnostics?.exactQuoteMatch, 'boolean');
        assert.equal(typeof event.quoteMatchDiagnostics?.caseOnlyMatch, 'boolean');
        assert.equal(typeof event.quoteMatchDiagnostics?.punctuationOnlyMatch, 'boolean');
        assert.equal(typeof event.quoteMatchDiagnostics?.unicodeNormalizationMatch, 'boolean');
      }
    });
  }
});

test('both providers failing returns a safe fallback error', async () => {
  await assert.rejects(extractFindings(source, {
    client: clientFrom([failure(503)]), maxRetries: 0,
    cloudflareMaxRetries: 0,
    cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token',
    cloudflareFetch: async () => ({ ok: false, status: 503 }),
  }), (error) => error instanceof GeminiAnalysisError && error.status === 503 && error.message === 'Neither AI provider could complete the analysis.');
});

test('fallback validation rejects incomplete or out-of-contract finding structures', async () => {
  await assert.rejects(extractFindings(source, {
    client: clientFrom([failure(503)]), maxRetries: 0,
    cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token',
    cloudflareFetch: async () => cloudflareResponse([{ category: 'Not a RELAY category', title: 'Invalid', description: 'Invalid', quote: 'The team decided to ship the beta in June.' }]),
  }), (error) => error instanceof GeminiAnalysisError && error.kind === 'invalid_response');
});
