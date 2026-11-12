import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFindings, GeminiAnalysisError } from '../src/services/gemini.js';
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

test('uses a short SDK timeout with built-in retries disabled', async () => {
  let configured;
  const result = await extractFindings(source, {
    timeoutMs: 12_345,
    clientFactory: (config) => { configured = config; return clientFrom([response]); },
    sleep: async () => {},
  });
  assert.equal(configured.timeout, 12_345);
  assert.equal(configured.maxRetries, 0);
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

test('maps exhausted provider timeouts to 504 and stops after the configured retry', async () => {
  const timeout = Object.assign(new Error('request timed out'), { name: 'APIConnectionTimeoutError' });
  const client = clientFrom([timeout, timeout]);
  const delays = [];
  await assert.rejects(
    extractFindings(source, { client, maxRetries: 1, sleep: async (delay) => delays.push(delay) }),
    (error) => error instanceof GeminiAnalysisError && error.status === 504 && error.kind === 'timeout',
  );
  assert.equal(client.calls, 2);
  assert.deepEqual(delays, [500]);
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

test('sanitizes credentials and request tokens before error logging', () => {
  const value = 'API_KEY=AIzaSyAbcdefghijklmnopqrstuvwxyz012345 eyJabcdefghij.klmnopqrst.uvwxyz12345 Bearer sensitive-token\nauthorization: Bearer header-token\ncookie: sid=cookie-secret; jwt=another-secret\nmongodb+srv://user:pass@host/db';
  const safe = sanitizeLogText(value);
  assert.doesNotMatch(safe, /AIzaSy|eyJabcdefghij|user:pass|header-token|cookie-secret|another-secret/);
  assert.match(safe, /REDACTED_API_KEY/);
  assert.match(safe, /REDACTED_JWT/);
  assert.match(safe, /REDACTED_MONGODB_URI/);
});
