import { GoogleGenAI } from '@google/genai';
import { verifyEvidenceQuote } from './evidenceVerification.js';
const allowed = ['Decision', 'Completed Work', 'Pending Tasks', 'Responsibilities', 'Blockers', 'Dependencies', 'Risks', 'Next Actions', 'Unresolved Questions'];
export const GEMINI_TIMEOUT_MS = 30_000;
export const GEMINI_MAX_RETRIES = 2;
export const CLOUDFLARE_MODEL = '@cf/openai/gpt-oss-20b';
export const DEFAULT_ANALYSIS_PROVIDER = 'cloudflare';

export class GeminiAnalysisError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'GeminiAnalysisError';
    this.status = options.status || 503;
    this.kind = options.kind || 'provider';
    this.provider = options.provider || 'gemini';
    this.providerStatus = options.providerStatus;
    this.retryable = options.retryable || false;
    this.providerAttempts = options.providerAttempts;
  }
}

function errorChain(error) {
  const pending = [error];
  const seen = new Set();
  const chain = [];
  while (pending.length && chain.length < 12) {
    const current = pending.shift();
    if (!current || (typeof current !== 'object' && typeof current !== 'function') || seen.has(current)) continue;
    seen.add(current);
    chain.push(current);
    for (const key of ['cause', 'error', 'originalError', 'response']) {
      try { if (current[key] && typeof current[key] === 'object') pending.push(current[key]); } catch {}
    }
  }
  return chain;
}

function providerStatus(error) {
  for (const current of errorChain(error)) {
    for (const field of ['providerStatus', 'status', 'statusCode', 'status_code']) {
      if (current instanceof GeminiAnalysisError && field === 'status' && current.providerStatus === undefined) continue;
      const status = Number(current[field]);
      if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
    }
  }
  return undefined;
}

const timeoutCodes = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ERR_SOCKET_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const networkCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN', 'ENOTFOUND', 'EHOSTUNREACH', 'EHOSTDOWN', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT']);
const diagnosticErrorClasses = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ApiError', 'APIError', 'GoogleGenAIError', 'APIConnectionError', 'APIConnectionTimeoutError', 'APIUserAbortError', 'AbortError', 'TimeoutError', 'FetchError', 'RequestError']);

function safeErrorClass(error) {
  const name = typeof error?.name === 'string' ? error.name : error?.constructor?.name;
  return diagnosticErrorClasses.has(name) ? name : 'OtherError';
}

function safeErrorCode(error) {
  if (timeoutCodes.has(error?.code) || networkCodes.has(error?.code)) return error.code;
  return undefined;
}

function safeErrorDiagnostics(error) {
  const pending = [{ value: error, via: 'root' }];
  const seen = new Set();
  const wrapperChain = [];
  const relations = ['cause', 'error', 'originalError', 'response'];
  while (pending.length && wrapperChain.length < 6) {
    const { value, via } = pending.shift();
    if (!value || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) continue;
    seen.add(value);
    const status = ['providerStatus', 'status', 'statusCode', 'status_code']
      .map((field) => Number(value[field]))
      .find((candidate) => Number.isInteger(candidate) && candidate >= 100 && candidate <= 599);
    wrapperChain.push({
      via,
      errorClass: safeErrorClass(value),
      ...(safeErrorCode(value) ? { errorCode: safeErrorCode(value) } : {}),
      ...(status === undefined ? {} : { httpStatus: status }),
    });
    for (const relation of relations) {
      try { if (value[relation] && typeof value[relation] === 'object') pending.push({ value: value[relation], via: relation }); } catch {}
    }
  }
  return { errorClass: safeErrorClass(error), wrapperChain };
}

function isUserCancellation(error) {
  return errorChain(error).some((current) => current.name === 'APIUserAbortError'
    || current.name === 'AbortError'
    || current.code === 'ABORT_ERR');
}

function isTimeout(error) {
  if (isUserCancellation(error)) return false;
  return errorChain(error).some((current) => timeoutCodes.has(current.code)
    || current.name === 'APIConnectionTimeoutError'
    || current.name === 'TimeoutError'
    || /^(?:request|connection|connect|socket|operation) (?:has )?timed out[.!]?$/i.test(current.message || ''));
}

function isNetworkFailure(error) {
  if (isUserCancellation(error)) return false;
  return errorChain(error).some((current) => current.name === 'APIConnectionError' || networkCodes.has(current.code));
}

function isTemporaryHttpStatus(status) {
  return status === 408 || status === 429 || [500, 502, 503, 504].includes(status);
}

function isRetryable(error) {
  if (isUserCancellation(error)) return false;
  const status = providerStatus(error);
  if (status === 401 || status === 403) return false;
  if (status !== undefined) return isTemporaryHttpStatus(status);
  return isTimeout(error) || isNetworkFailure(error);
}

function publicProviderStatus(error) {
  const status = providerStatus(error);
  if (isTimeout(error) || status === 408) return 504;
  if (status === 429) return 429;
  if (status !== undefined && status >= 500) return 503;
  return 502;
}

function providerDiagnostic(provider, phase, fields = {}) {
  console.info(JSON.stringify({ level: 'info', operation: 'analysis.providerRequest', provider, phase, ...fields }));
}

function attemptMetadata(provider, error, fallbackOccurred = false) {
  const status = providerStatus(error);
  let category = 'unknown';
  let errorCode = 'unknown';
  if (error?.kind === 'configuration') { category = 'configuration'; errorCode = 'configuration_error'; }
  else if (error?.kind === 'invalid_response') { category = 'invalid_output'; errorCode = 'invalid_output'; }
  else if (status !== undefined) { category = 'http'; errorCode = 'http_error'; }
  else if (isTimeout(error)) { category = 'timeout'; errorCode = 'timeout'; }
  else if (isNetworkFailure(error)) {
    category = 'network'; errorCode = 'network_error';
  }
  const outcome = error?.kind === 'configuration' ? 'configuration_failure'
    : error?.kind === 'invalid_response' ? 'invalid_output'
      : isRetryable(error) ? 'temporary_failure' : 'permanent_failure';
  return { provider, role: fallbackOccurred ? 'secondary' : 'primary', outcome, category, errorCode, ...(status === undefined ? {} : { status }) };
}

function recordProviderAttempt(options, attempt) {
  options.providerAttempts.push(attempt);
}

async function measuredRequest(provider, request, fallbackOccurred, options) {
  const startedAt = Date.now();
  providerDiagnostic(provider, 'started', { fallbackOccurred });
  try {
    const result = await request();
    recordProviderAttempt(options, { provider, role: fallbackOccurred ? 'secondary' : 'primary', outcome: 'success', category: 'success', errorCode: 'none' });
    providerDiagnostic(provider, 'completed', { durationMs: Date.now() - startedAt, success: true, fallbackOccurred });
    return result;
  } catch (error) {
    const attempt = attemptMetadata(provider, error, fallbackOccurred);
    recordProviderAttempt(options, attempt);
    const safeError = safeErrorDiagnostics(error);
    providerDiagnostic(provider, 'completed', {
      durationMs: Date.now() - startedAt,
      success: false,
      fallbackOccurred,
      ...safeError,
      failureCategory: attempt.category,
      errorCode: attempt.errorCode,
      outcome: attempt.outcome,
      ...(providerStatus(error) ? { providerStatus: providerStatus(error) } : {}),
      ...(isTimeout(error) ? { timeout: true } : {}),
    });
    throw error;
  }
}

function parseFindings(response, source, strict, provider) {
  const backticks = String.fromCharCode(96);
  const raw = (response.text || '')
    .replace(new RegExp('^' + backticks + '{3}(?:json)?\\s*', 'i'), '')
    .replace(new RegExp('\\s*' + backticks + '{3}$'), '');
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (cause) { throw new GeminiAnalysisError('AI provider returned an unreadable analysis response.', { status: 502, kind: 'invalid_response', provider, cause }); }
  if (!Array.isArray(parsed.findings)) throw new GeminiAnalysisError('AI provider response did not contain a findings list.', { status: 502, kind: 'invalid_response', provider });
  const findings = [];
  for (const finding of parsed.findings) {
    const validBase = finding && allowed.includes(finding.category) && finding.title && finding.description;
    const validStrict = validBase && typeof finding.title === 'string' && finding.title.trim()
      && typeof finding.description === 'string' && finding.description.trim()
      && (!('confidence' in finding) || (Number.isFinite(finding.confidence) && finding.confidence >= 0 && finding.confidence <= 1));
    if (!(strict ? validStrict : validBase)) {
      if (strict) throw new GeminiAnalysisError(provider + ' returned a finding that failed RELAY validation.', { status: 502, kind: 'invalid_response', provider });
      continue;
    }
    const evidence = verifyEvidenceQuote({
      sourceId: source._id,
      sourceName: source.originalName,
      sourceText: source.extractedText,
      quote: typeof finding.quote === 'string' ? finding.quote : '',
      section: strict ? '' : (typeof finding.section === 'string' ? finding.section : ''),
    });
    if (strict && evidence.verificationStatus !== 'verified') {
      throw new GeminiAnalysisError(provider + ' returned evidence that could not be verified against the source.', { status: 502, kind: 'invalid_response', provider });
    }
    if (strict && (finding.title.length > 500 || finding.description.length > 5000)) {
      throw new GeminiAnalysisError(provider + ' returned a finding that exceeded RELAY limits.', { status: 502, kind: 'invalid_response', provider });
    }
    findings.push({
      category: finding.category,
      title: finding.title.slice(0, 500),
      description: finding.description.slice(0, 5000),
      confidence: Math.max(0, Math.min(1, Number(finding.confidence) || 0.5)),
      evidence: [evidence],
    });
  }
  return findings;
}

function createPrompt(source) {
  return 'Analyze this project document for handover. Return ONLY JSON: {"findings":[{"category":"one of '
    + allowed.join(', ')
    + '","title":"...","description":"...","confidence":0.0,"quote":"exact supporting quote copied from source","section":"page/heading/section only if explicitly available"}]}. Never infer a quote, page or section. If no evidence exists, omit the finding. Confidence must be 0..1. Document name: '
    + source.originalName
    + '\n\nDOCUMENT TEXT:\n'
    + String(source.extractedText || '').slice(0, 45000);
}

function isTemporaryProviderFailure(error) {
  if (!(error instanceof GeminiAnalysisError) || !['provider', 'timeout'].includes(error.kind)) return false;
  const status = error.providerStatus;
  if (status === 401 || status === 403) return false;
  if (status !== undefined) return isTemporaryHttpStatus(status);
  return error.retryable === true;
}

function getGeminiClient(options, apiKey, timeoutMs) {
  const httpOptions = { timeout: timeoutMs, retryOptions: { attempts: 1 } };
  return options.client || (options.clientFactory
    ? options.clientFactory({ apiKey, httpOptions })
    : new GoogleGenAI({ apiKey, httpOptions }));
}

async function requestGemini(source, prompt, options, fallbackOccurred) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey && !options.client && !options.clientFactory) {
    const error = new GeminiAnalysisError('Gemini is not configured on the server.', { status: 503, kind: 'configuration', provider: 'gemini' });
    recordProviderAttempt(options, attemptMetadata('gemini', error, fallbackOccurred));
    error.providerAttempts = options.providerAttempts;
    throw error;
  }
  const timeoutMs = options.timeoutMs || GEMINI_TIMEOUT_MS;
  const maxRetries = options.maxRetries === undefined ? GEMINI_MAX_RETRIES : options.maxRetries;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let client;
  try { client = getGeminiClient(options, apiKey, timeoutMs); }
  catch {
    const error = new GeminiAnalysisError('Gemini could not be initialized with the server configuration.', { status: 503, kind: 'configuration', provider: 'gemini' });
    recordProviderAttempt(options, attemptMetadata('gemini', error, fallbackOccurred));
    error.providerAttempts = options.providerAttempts;
    throw error;
  }

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await measuredRequest('gemini', () => client.models.generateContent({
        model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
        contents: prompt,
      }), fallbackOccurred, options);
      return { response, provider: 'gemini' };
    } catch (error) {
      const retry = attempt < maxRetries && isRetryable(error);
      providerDiagnostic('gemini', 'retry', { attempt: attempt + 1, maxAttempts: maxRetries + 1, retrying: retry, fallbackOccurred });
      if (!retry) {
        const analysisError = new GeminiAnalysisError(
          isTimeout(error) ? 'Gemini analysis timed out.' : 'Gemini could not complete the analysis.',
          { status: publicProviderStatus(error), kind: isTimeout(error) ? 'timeout' : 'provider', provider: 'gemini', providerStatus: providerStatus(error), retryable: isRetryable(error), cause: error, providerAttempts: options.providerAttempts },
        );
        throw analysisError;
      }
      await sleep(500 * (2 ** attempt));
    }
  }
  throw new GeminiAnalysisError('Gemini could not complete the analysis.', { status: 503, kind: 'provider', provider: 'gemini' });
}

async function requestCloudflare(source, prompt, options, fallbackOccurred) {
  const accountId = String(Object.hasOwn(options, 'cloudflareAccountId') ? options.cloudflareAccountId || '' : process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  const apiToken = String(Object.hasOwn(options, 'cloudflareApiToken') ? options.cloudflareApiToken || '' : process.env.CLOUDFLARE_API_TOKEN || '').trim();
  if (!accountId || !apiToken) {
    const error = new GeminiAnalysisError('Cloudflare Workers AI is not configured on the server.', { status: 503, kind: 'configuration', provider: 'cloudflare' });
    recordProviderAttempt(options, attemptMetadata('cloudflare', error, fallbackOccurred));
    error.providerAttempts = options.providerAttempts;
    throw error;
  }
  const timeoutMs = options.cloudflareTimeoutMs || GEMINI_TIMEOUT_MS;
  const maxRetries = options.cloudflareMaxRetries === undefined ? GEMINI_MAX_RETRIES : options.cloudflareMaxRetries;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const fetchImpl = options.cloudflareFetch || globalThis.fetch;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const payload = await measuredRequest('cloudflare', async () => {
        let response;
        try {
          response = await fetchImpl(
            'https://api.cloudflare.com/client/v4/accounts/' + encodeURIComponent(accountId) + '/ai/run/' + CLOUDFLARE_MODEL,
            {
              method: 'POST',
              headers: { Authorization: 'Bearer ' + apiToken, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 2048,
                reasoning_effort: 'low',
                temperature: 0,
              }),
              signal: AbortSignal.timeout(timeoutMs),
            },
          );
        } catch (cause) {
          throw new GeminiAnalysisError('Cloudflare Workers AI request failed before receiving a response.', {
            status: isTimeout(cause) ? 504 : 503,
            kind: isTimeout(cause) ? 'timeout' : 'provider',
            provider: 'cloudflare',
            retryable: isRetryable(cause),
            cause,
          });
        }
        if (!response.ok) {
          throw new GeminiAnalysisError('Cloudflare Workers AI returned an unsuccessful response.', {
            status: response.status === 408 ? 504 : response.status === 429 ? 429 : response.status >= 500 ? 503 : 502,
            kind: 'provider',
            provider: 'cloudflare',
            providerStatus: response.status,
            retryable: isTemporaryHttpStatus(response.status),
          });
        }
        try { return await response.json(); }
        catch (cause) {
          throw new GeminiAnalysisError('Cloudflare returned an unreadable analysis response.', { status: 502, kind: 'invalid_response', provider: 'cloudflare', cause });
        }
      }, fallbackOccurred, options);
      return { response: payload, provider: 'cloudflare' };
    } catch (error) {
      const analysisError = error instanceof GeminiAnalysisError
        ? error
        : new GeminiAnalysisError('Cloudflare Workers AI request failed.', { status: 503, kind: 'provider', provider: 'cloudflare', retryable: isRetryable(error), cause: error });
      const retry = attempt < maxRetries && isTemporaryProviderFailure(analysisError);
      providerDiagnostic('cloudflare', 'retry', { attempt: attempt + 1, maxAttempts: maxRetries + 1, retrying: retry, fallbackOccurred });
      if (!retry) {
        analysisError.providerAttempts = options.providerAttempts;
        throw analysisError;
      }
      await sleep(500 * (2 ** attempt));
    }
  }
  throw new GeminiAnalysisError('Cloudflare Workers AI could not complete the analysis.', { status: 503, kind: 'provider', provider: 'cloudflare' });
}

function cloudflareModelText(payload) {
  if (!payload || payload.success !== true) {
    throw new GeminiAnalysisError('Cloudflare returned an incomplete analysis response.', { status: 502, kind: 'invalid_response', provider: 'cloudflare' });
  }
  const output = typeof (payload.result && payload.result.response) === 'string'
    ? payload.result.response
    : payload.result && payload.result.response && typeof payload.result.response === 'object' && Array.isArray(payload.result.response.findings)
      ? JSON.stringify(payload.result.response)
      : payload.result && Array.isArray(payload.result.choices)
        && payload.result.choices[0] && payload.result.choices[0].message
        && typeof payload.result.choices[0].message.content === 'string'
        ? payload.result.choices[0].message.content
        : null;
  if (!output) throw new GeminiAnalysisError('Cloudflare returned an incomplete analysis response.', { status: 502, kind: 'invalid_response', provider: 'cloudflare' });
  return { text: output };
}

export async function extractFindings(source, options = {}) {
  options = { ...options, providerAttempts: [] };
  const prompt = createPrompt(source);
  const primaryProvider = options.primaryProvider || DEFAULT_ANALYSIS_PROVIDER;
  if (!['cloudflare', 'gemini'].includes(primaryProvider)) throw new TypeError('Unsupported analysis provider selection.');
  const providers = primaryProvider === 'cloudflare' ? ['cloudflare', 'gemini'] : ['gemini', 'cloudflare'];
  let providerResult;
  let fallbackOccurred = false;

  try {
    providerResult = providers[0] === 'cloudflare'
      ? await requestCloudflare(source, prompt, options, false)
      : await requestGemini(source, prompt, options, false);
  } catch (primaryError) {
    if (!isTemporaryProviderFailure(primaryError)) throw primaryError;
    fallbackOccurred = true;
    providerDiagnostic('analysis', 'fallback', {
      fallbackOccurred: true,
      fromProvider: providers[0],
      toProvider: providers[1],
      reason: primaryError.providerStatus || (primaryError.kind === 'timeout' ? 'timeout' : 'temporary_network_failure'),
    });
    try {
      providerResult = providers[1] === 'cloudflare'
        ? await requestCloudflare(source, prompt, options, true)
        : await requestGemini(source, prompt, options, true);
    } catch (fallbackError) {
      if (fallbackError instanceof GeminiAnalysisError) fallbackError.providerAttempts = options.providerAttempts;
      if (fallbackError instanceof GeminiAnalysisError && fallbackError.kind === 'invalid_response') {
        throw fallbackError;
      }
      throw new GeminiAnalysisError('Neither AI provider could complete the analysis.', {
        status: fallbackError.status || 503,
        kind: fallbackError.kind || 'fallback_provider',
        provider: fallbackError.provider || providers[1],
        providerStatus: fallbackError.providerStatus,
        retryable: fallbackError.retryable,
        providerAttempts: options.providerAttempts,
      });
    }
  }

  const strict = providerResult.provider === 'cloudflare';
  let findings;
  try {
    const response = strict ? cloudflareModelText(providerResult.response) : providerResult.response;
    findings = parseFindings(response, source, strict, providerResult.provider);
  } catch (error) {
    if (error instanceof GeminiAnalysisError && error.kind === 'invalid_response') {
      const latestAttempt = options.providerAttempts.at(-1);
      if (latestAttempt) Object.assign(latestAttempt, { outcome: 'invalid_output', category: 'invalid_output', errorCode: 'invalid_output' });
      error.providerAttempts = options.providerAttempts;
      providerDiagnostic(providerResult.provider, 'validationFailed', { fallbackOccurred, reason: error.kind });
    }
    throw error;
  }
  providerDiagnostic(providerResult.provider, 'analysisValidated', {
    fallbackOccurred,
    findingCount: findings.length,
    allEvidenceVerified: findings.every((finding) => finding.evidence.every((item) => item.verificationStatus === 'verified')),
  });
  Object.defineProperty(findings, 'providerAttempts', { value: options.providerAttempts, enumerable: false });
  return findings;
}
