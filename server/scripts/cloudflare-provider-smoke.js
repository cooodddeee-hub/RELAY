import 'dotenv/config';
import { CLOUDFLARE_MODEL, DEFAULT_ANALYSIS_PROVIDER, extractFindings } from '../src/services/gemini.js';

// Run from server/: node scripts/cloudflare-provider-smoke.js
const source = {
  _id: 'relay-cloudflare-smoke-source',
  originalName: 'relay-synthetic-smoke.txt',
  extractedText: 'Synthetic RELAY provider check. The fictional Acorn project decided to launch version 1 on 2032-05-14. Project owner Mira will prepare the launch checklist.',
};

function report(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_API_TOKEN) {
  report({ status: 'FAIL', provider: 'cloudflare', model: CLOUDFLARE_MODEL, reason: 'required_server_configuration_missing' });
  process.exitCode = 1;
} else {
  let httpStatus = null;
  let geminiCalls = 0;
  try {
    const findings = await extractFindings(source, {
      cloudflareMaxRetries: 0,
      maxRetries: 2,
      // Simulate eligible Gemini 503s; no live Gemini request is made.
      client: { models: { generateContent: async () => {
        geminiCalls += 1;
        throw Object.assign(new Error('Synthetic temporary Gemini failure.'), { status: 503 });
      } } },
      cloudflareFetch: async (url, options) => {
        const response = await fetch(url, options);
        httpStatus = response.status;
        return response;
      },
    });
    const evidenceValid = findings.length > 0 && findings.every((finding) =>
      finding.evidence?.length > 0 && finding.evidence.every((item) =>
        item.verificationStatus === 'verified'
        && item.source === source._id
        && item.matchedText
        && source.extractedText.includes(item.matchedText)));
    const attempts = findings.providerAttempts || [];
    const providerSucceeded = attempts.some((attempt) => attempt.provider === 'cloudflare' && attempt.outcome === 'success');
    const fallbackSequenceValid = DEFAULT_ANALYSIS_PROVIDER === 'gemini'
      && geminiCalls === 3
      && attempts.length === 4
      && attempts.slice(0, 3).every((attempt) => attempt.provider === 'gemini' && attempt.outcome === 'temporary_failure' && attempt.status === 503)
      && attempts[3].provider === 'cloudflare'
      && attempts[3].outcome === 'success';
    if (!providerSucceeded || !evidenceValid || !fallbackSequenceValid) {
      report({ status: 'FAIL', provider: 'cloudflare', model: CLOUDFLARE_MODEL, httpStatus, reason: providerSucceeded ? 'fallback_or_strict_validation_failed' : 'provider_request_not_successful' });
      process.exitCode = 1;
    } else {
      report({ status: 'PASS', provider: 'cloudflare', model: CLOUDFLARE_MODEL, simulatedGeminiTemporaryAttempts: geminiCalls, cloudflareFallbackInvoked: true, acceptedFindingCount: findings.length, exactEvidenceVerified: true, sourceAssociationPreserved: true });
    }
  } catch (error) {
    const message = String(error?.message || '').toLowerCase();
    const failureReasons = [
      [/unreadable analysis response/.test(message), 'output_not_json'],
      [/did not contain a findings list/.test(message), 'findings_list_missing'],
      [/finding that failed relay validation/.test(message), 'finding_schema_invalid'],
      [/evidence that could not be verified/.test(message), 'evidence_not_verified'],
      [/finding that exceeded relay limits/.test(message), 'finding_limit_exceeded'],
      [/incomplete analysis response/.test(message), 'response_shape_invalid'],
    ];
    const validationFailure = failureReasons.find(([matches]) => matches)?.[1] || 'provider_or_validation_error';
    report({
      status: 'FAIL',
      provider: error?.provider || 'cloudflare',
      model: CLOUDFLARE_MODEL,
      httpStatus,
      errorKind: error?.kind || 'unknown',
      reason: validationFailure,
      statusCode: Number.isInteger(error?.providerStatus) ? error.providerStatus : null,
      retryable: error?.retryable === true,
    });
    process.exitCode = 1;
  }
}
