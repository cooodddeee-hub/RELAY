import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '@google/genai';
import { extractFindings, GeminiAnalysisError, CLOUDFLARE_MODEL, DEFAULT_ANALYSIS_PROVIDER } from '../src/services/gemini.js';
import { publicAnalysisJob, safeProviderAttempts } from '../src/services/analysisJobState.js';
import { sanitizeLogText } from '../src/utils/safeLogger.js';

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

test('analysis retains paraphrased quotes as unverified evidence with the original source association', async () => {
  const paraphrasedResponse = { text: JSON.stringify({ findings: [{ category: 'Decision', title: 'Beta timing', description: 'The beta was planned for summer.', quote: 'The beta is set for early summer.' }] }) };
  const result = await extractFindings(source, { client: clientFrom([paraphrasedResponse]) });
  assert.equal(result[0].evidence[0].quote, 'The beta is set for early summer.');
  assert.equal(result[0].evidence[0].verificationStatus, 'unverified');
  assert.equal(result[0].evidence[0].source, source._id);
  assert.equal('matchedText' in result[0].evidence[0], false);
});

test('retries temporary 503 failures with exponential backoff then returns real findings', async () => {
  const client = clientFrom([failure(503), failure(503), response]);
  const delays = [];
  const result = await extractFindings(source, { client, maxRetries: 2, sleep: async (delay) => delays.push(delay) });
  assert.equal(client.calls, 3);
  assert.deepEqual(delays, [500, 1000]);
  assert.equal(result[0].title, 'Ship the beta in June');
});

test('retries 429 rate limits and succeeds without inventing output', async () => {
  const client = clientFrom([failure(429, 'quota temporarily exhausted'), response]);
  const delays = [];
  const result = await extractFindings(source, { client, maxRetries: 1, sleep: async (delay) => delays.push(delay) });
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
    extractFindings(source, { client, maxRetries: 2, sleep: async () => assert.fail('permanent errors must not retry') }),
    (error) => error instanceof GeminiAnalysisError && error.status === 502,
  );
  assert.equal(client.calls, 1);
});

test('does not turn malformed provider output into findings', async () => {
  const client = clientFrom([{ text: 'not JSON' }]);
  await assert.rejects(
    extractFindings(source, { client }),
    (error) => error instanceof GeminiAnalysisError && error.kind === 'invalid_response',
  );
  assert.equal(client.calls, 1);
});

test('malformed Gemini output does not trigger Cloudflare fallback', async () => {
  let fallbackCalls = 0;
  await assert.rejects(extractFindings(source, {
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

function cloudflareResponse(findings = [{ category: 'Decision', title: 'Ship the beta', description: 'The source says the beta will ship in June.', confidence: 0.9, quote: 'The team decided to ship the beta in June.' }]) {
  return { ok: true, status: 200, json: async () => ({ success: true, result: { response: JSON.stringify({ findings }) } }) };
}

test('Gemini succeeds without calling Cloudflare', async () => {
  let fallbackCalls = 0;
  const result = await extractFindings(source, {
    client: clientFrom([response]),
    cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token',
    cloudflareFetch: async () => { fallbackCalls += 1; throw new Error('must not be called'); },
  });
  assert.equal(result.length, 1);
  assert.equal(fallbackCalls, 0);
  assert.deepEqual(result.providerAttempts, [
    { provider: 'gemini', outcome: 'success', category: 'success', errorCode: 'none' },
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

test('Cloudflare success metadata passes the persistence sanitizer and public status projection', async () => {
  const findings = await extractFindings(source, {
    client: clientFrom([failure(503)]), maxRetries: 0,
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
  assert.deepEqual(jobStatus.lastProviderAttempts.map(({ provider, outcome }) => ({ provider, outcome })), [
    { provider: 'gemini', outcome: 'temporary_failure' },
    { provider: 'cloudflare', outcome: 'success' },
  ]);
  assert.equal(jobStatus.demoFallbackAvailable, false);
});

test('installed SDK APIConnectionTimeoutError shape is retryable through its dedicated name', async () => {
  const timeout = Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' });
  const client = clientFrom([timeout, timeout]);
  let fallbackCalls = 0;
  const result = await extractFindings(source, {
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
    client, maxRetries: 2,
    cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token',
    cloudflareFetch: async () => { fallbackCalls += 1; return cloudflareResponse(); },
  }), (error) => error instanceof GeminiAnalysisError && error.retryable === false && error.kind === 'provider');
  assert.equal(client.calls, 1);
  assert.equal(fallbackCalls, 0);
});

test('Cloudflare candidate is configured with the selected model and is not enabled as primary before live validation', () => {
  assert.equal(CLOUDFLARE_MODEL, '@cf/openai/gpt-oss-20b');
  assert.equal(DEFAULT_ANALYSIS_PROVIDER, 'gemini');
});

test('Cloudflare primary validates schema, exact evidence, and source association', async () => {
  let request;
  const result = await extractFindings(source, {
    primaryProvider: 'cloudflare',
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
  assert.equal(result.length, 1);
  assert.equal(result[0].evidence[0].source, source._id);
  assert.equal(result[0].evidence[0].verificationStatus, 'verified');
  assert.equal(result[0].evidence[0].matchedText, source.extractedText);
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
    primaryProvider: 'cloudflare',
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
});

test('Cloudflare authentication and permanent response failures do not fall back', async () => {
  let geminiCalls = 0;
  await assert.rejects(extractFindings(source, {
    primaryProvider: 'cloudflare',
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
      client: clientFrom([failure(status, 'auth or permission failure')]), maxRetries: 0,
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
    client, maxRetries: 1, sleep: async (delay) => delays.push(delay),
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
    client: clientFrom([new TypeError('unexpected application failure')]), maxRetries: 0,
    cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token',
    cloudflareFetch: async () => { fallbackCalls += 1; return cloudflareResponse(); },
  }), (error) => error instanceof GeminiAnalysisError && error.provider === 'gemini');
  assert.equal(fallbackCalls, 0);
});

test('an unrelated Gemini error mentioning network is not retried or sent to Cloudflare', async () => {
  let fallbackCalls = 0;
  const client = clientFrom([new Error('network field validation failed')]);
  await assert.rejects(extractFindings(source, {
    client, maxRetries: 2,
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

test('Cloudflare exhausted temporary attempts preserve both providers and safe classification metadata', async () => {
  await assert.rejects(extractFindings(source, {
    client: clientFrom([failure(503)]), maxRetries: 0,
    cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token', cloudflareMaxRetries: 1,
    cloudflareFetch: async () => ({ ok: false, status: 503 }),
    sleep: async () => {},
  }), (error) => {
    assert.deepEqual(error.providerAttempts.map(({ provider, outcome, status, category, errorCode }) => ({ provider, outcome, status, category, errorCode })), [
      { provider: 'gemini', outcome: 'temporary_failure', status: 503, category: 'http', errorCode: 'http_error' },
      { provider: 'cloudflare', outcome: 'temporary_failure', status: 503, category: 'http', errorCode: 'http_error' },
      { provider: 'cloudflare', outcome: 'temporary_failure', status: 503, category: 'http', errorCode: 'http_error' },
    ]);
    assert.equal(error.kind, 'provider');
    assert.equal(error.retryable, true);
    assert.equal(JSON.stringify(error.providerAttempts).includes(source.extractedText), false);
    return true;
  });
});

test('Gemini and eligible Cloudflare temporary failures carry only safe provider attempt metadata', async () => {
  await assert.rejects(extractFindings(source, {
    client: clientFrom([failure(503)]), maxRetries: 0,
    cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token', cloudflareMaxRetries: 0,
    cloudflareFetch: async () => ({ ok: false, status: 503 }),
  }), (error) => {
    assert.deepEqual(error.providerAttempts, [
      { provider: 'gemini', outcome: 'temporary_failure', status: 503, category: 'http', errorCode: 'http_error' },
      { provider: 'cloudflare', outcome: 'temporary_failure', status: 503, category: 'http', errorCode: 'http_error' },
    ]);
    assert.equal(JSON.stringify(error.providerAttempts).includes(source.extractedText), false);
    assert.equal(JSON.stringify(error.providerAttempts).includes('test-token'), false);
    return error instanceof GeminiAnalysisError && error.kind === 'provider';
  });
});

test('a permanent Cloudflare fallback failure is recorded as non-eligible for demo fallback', async () => {
  await assert.rejects(extractFindings(source, {
    client: clientFrom([failure(503)]), maxRetries: 0,
    cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token', cloudflareMaxRetries: 0,
    cloudflareFetch: async () => ({ ok: false, status: 401 }),
  }), (error) => {
    assert.deepEqual(error.providerAttempts, [
      { provider: 'gemini', outcome: 'temporary_failure', status: 503, category: 'http', errorCode: 'http_error' },
      { provider: 'cloudflare', outcome: 'permanent_failure', status: 401, category: 'http', errorCode: 'http_error' },
    ]);
    return error instanceof GeminiAnalysisError && error.kind === 'provider';
  });
});

test('a wrapped Gemini authentication failure does not retry or invoke Cloudflare', async () => {
  let fallbackCalls = 0;
  const wrapped401 = Object.assign(new Error('request failed'), { cause: { error: { status: 401 } } });
  const client = clientFrom([wrapped401]);
  await assert.rejects(extractFindings(source, {
    client, maxRetries: 2, cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token',
    cloudflareFetch: async () => { fallbackCalls += 1; return cloudflareResponse(); },
  }), (error) => error instanceof GeminiAnalysisError && error.providerStatus === 401 && error.retryable === false);
  assert.equal(client.calls, 1);
  assert.equal(fallbackCalls, 0);
});

test('Gemini client configuration errors do not invoke Cloudflare', async () => {
  let fallbackCalls = 0;
  await assert.rejects(extractFindings(source, {
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

test('Cloudflare findings with unsupported evidence are rejected instead of accepted as unverified', async () => {
  await assert.rejects(extractFindings(source, {
    client: clientFrom([failure(503)]), maxRetries: 0,
    cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token',
    cloudflareFetch: async () => cloudflareResponse([{ category: 'Decision', title: 'Invented fact', description: 'Not in source.', quote: 'The team selected a launch date of August.' }]),
  }), (error) => error instanceof GeminiAnalysisError && error.kind === 'invalid_response' && /verified against the source/.test(error.message));
});

test('both providers failing returns a safe fallback error', async () => {
  await assert.rejects(extractFindings(source, {
    client: clientFrom([failure(503)]), maxRetries: 0,
    cloudflareMaxRetries: 0,
    cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token',
    cloudflareFetch: async () => { throw new Error('network failure including a private URL'); },
  }), (error) => error instanceof GeminiAnalysisError && error.status === 503 && error.message === 'Neither AI provider could complete the analysis.');
});

test('fallback validation rejects incomplete or out-of-contract finding structures', async () => {
  await assert.rejects(extractFindings(source, {
    client: clientFrom([failure(503)]), maxRetries: 0,
    cloudflareAccountId: 'test-account', cloudflareApiToken: 'test-token',
    cloudflareFetch: async () => cloudflareResponse([{ category: 'Not a RELAY category', title: 'Invalid', description: 'Invalid', quote: 'The team decided to ship the beta in June.' }]),
  }), (error) => error instanceof GeminiAnalysisError && error.kind === 'invalid_response');
});
