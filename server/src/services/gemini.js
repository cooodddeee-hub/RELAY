import { GoogleGenAI } from '@google/genai';
import { logError, sanitizeLogText } from '../utils/safeLogger.js';
import { verifyEvidenceQuote } from './evidenceVerification.js';

const allowed = ['Decision', 'Completed Work', 'Pending Tasks', 'Responsibilities', 'Blockers', 'Dependencies', 'Risks', 'Next Actions', 'Unresolved Questions'];
export const GEMINI_TIMEOUT_MS = 30_000;
export const GEMINI_MAX_RETRIES = 2;

export class GeminiAnalysisError extends Error {
  constructor(message, { status = 503, kind = 'provider', cause } = {}) {
    super(message, { cause });
    this.name = 'GeminiAnalysisError';
    this.status = status;
    this.kind = kind;
  }
}

function providerStatus(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status ?? error?.error?.code);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

function isTimeout(error) {
  return /timeout|timed.?out|abort/i.test(`${error?.name || ''} ${error?.code || ''} ${error?.message || ''}`);
}

function isRetryable(error) {
  const status = providerStatus(error);
  if (isTimeout(error)) return true;
  if (status !== undefined) return status === 408 || status === 429 || status >= 500;
  return /APIConnectionError|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|fetch failed|network/i.test(`${error?.name || ''} ${error?.code || ''} ${error?.message || ''}`);
}

function publicProviderStatus(error) {
  const status = providerStatus(error);
  if (isTimeout(error)) return 504;
  if (status === 429) return 429;
  if (status !== undefined && status >= 500) return 503;
  return 502;
}

function parseFindings(response, source) {
  const raw = (response.text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (cause) { throw new GeminiAnalysisError('Gemini returned an unreadable analysis response.', { status: 502, kind: 'invalid_response', cause }); }
  if (!Array.isArray(parsed.findings)) throw new GeminiAnalysisError('Gemini response did not contain a findings list.', { status: 502, kind: 'invalid_response' });
  return parsed.findings.filter((finding) => allowed.includes(finding.category) && finding.title && finding.description).map((finding) => ({
    category: finding.category,
    title: String(finding.title).slice(0, 500),
    description: String(finding.description).slice(0, 5000),
    confidence: Math.max(0, Math.min(1, Number(finding.confidence) || 0.5)),
    evidence: [verifyEvidenceQuote({
      sourceId: source._id,
      sourceName: source.originalName,
      sourceText: source.extractedText,
      quote: typeof finding.quote === 'string' ? finding.quote : '',
      section: typeof finding.section === 'string' ? finding.section : '',
    })],
  }));
}

export async function extractFindings(source, options = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey && !options.client && !options.clientFactory) throw new GeminiAnalysisError('Gemini is not configured on the server.', { status: 503, kind: 'configuration' });

  const timeoutMs = options.timeoutMs ?? GEMINI_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? GEMINI_MAX_RETRIES;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const client = options.client || (options.clientFactory
    ? options.clientFactory({ apiKey, timeout: timeoutMs, maxRetries: 0 })
    : new GoogleGenAI({ apiKey, timeout: timeoutMs, maxRetries: 0 }));
  const prompt = `Analyze this project document for handover. Return ONLY JSON: {"findings":[{"category":"one of ${allowed.join(', ')}","title":"...","description":"...","confidence":0.0,"quote":"exact supporting quote copied from source","section":"page/heading/section if explicitly available"}]}. Never infer a quote, page or section. If no evidence exists, omit the finding. Confidence must be 0..1. Document name: ${source.originalName}\n\nDOCUMENT TEXT:\n${String(source.extractedText || '').slice(0, 45000)}`;
  let response;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      response = await client.models.generateContent({ model: process.env.GEMINI_MODEL || 'gemini-2.5-flash', contents: prompt });
      break;
    } catch (error) {
      const retry = attempt < maxRetries && isRetryable(error);
      const status = providerStatus(error);
      logError('gemini.generateContent', error, {
        sourceId: String(source._id || ''),
        attempt: attempt + 1,
        maxAttempts: maxRetries + 1,
        providerStatus: status || (isTimeout(error) ? 504 : undefined),
        retrying: retry,
      });
      if (!retry) {
        const statusCode = publicProviderStatus(error);
        throw new GeminiAnalysisError(
          isTimeout(error) ? 'Gemini analysis timed out.' : 'Gemini could not complete the analysis.',
          { status: statusCode, kind: isTimeout(error) ? 'timeout' : 'provider', cause: error },
        );
      }
      await sleep(500 * (2 ** attempt));
    }
  }

  try { return parseFindings(response, source); }
  catch (error) {
    logError('gemini.parseResponse', error, { sourceId: String(source._id || '') });
    if (error instanceof GeminiAnalysisError) throw error;
    throw new GeminiAnalysisError(sanitizeLogText(error.message), { status: 502, kind: 'invalid_response', cause: error });
  }
}
