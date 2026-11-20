import { createHash } from 'node:crypto';

const KiB = 1024;
const MiB = 1024 * KiB;

export const GITHUB_CONTENT_LIMITS = Object.freeze({
  total: 8 * MiB,
  readmeItem: 256 * KiB,
  commitItem: 8 * KiB,
  commits: 256 * KiB,
  issueItem: 16 * KiB,
  issues: 1 * MiB,
});

export function normalizeGitHubText(value) {
  if (typeof value !== 'string') throw new TypeError('GitHub text must be a string.');
  return value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').normalize('NFC');
}

export function utf8ByteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

export function truncateUtf8(value, maxBytes) {
  if (typeof value !== 'string' || !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError('Text and a nonnegative byte limit are required.');
  }
  let text = '';
  let byteLength = 0;
  for (const codePoint of value) {
    const nextBytes = utf8ByteLength(codePoint);
    if (byteLength + nextBytes > maxBytes) break;
    text += codePoint;
    byteLength += nextBytes;
  }
  return { text, byteLength, truncated: byteLength < utf8ByteLength(value) };
}

export function createGitHubContentBudget({
  totalLimit = GITHUB_CONTENT_LIMITS.total,
  categoryLimits = {
    readme: GITHUB_CONTENT_LIMITS.readmeItem,
    commits: GITHUB_CONTENT_LIMITS.commits,
    issues: GITHUB_CONTENT_LIMITS.issues,
  },
} = {}) {
  if (!Number.isSafeInteger(totalLimit) || totalLimit < 0
    || !categoryLimits || typeof categoryLimits !== 'object') {
    throw new TypeError('Valid GitHub content limits are required.');
  }
  const usedByCategory = new Map();
  let totalUsed = 0;

  function remaining(category) {
    const categoryLimit = categoryLimits[category];
    if (!Number.isSafeInteger(categoryLimit) || categoryLimit < 0) throw new TypeError('Unknown GitHub content category.');
    return Math.max(0, Math.min(categoryLimit - (usedByCategory.get(category) || 0), totalLimit - totalUsed));
  }

  function record(category, fields, itemLimit, separator = '\n\n') {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)
      || !Number.isSafeInteger(itemLimit) || itemLimit < 0 || typeof separator !== 'string') {
      throw new TypeError('A bounded GitHub text record is required.');
    }
    const names = Object.keys(fields);
    if (names.some((name) => typeof fields[name] !== 'string')) throw new TypeError('GitHub text fields must be strings.');
    const normalized = Object.fromEntries(names.map((name) => [name, normalizeGitHubText(fields[name])]));
    const originalText = names.map((name) => normalized[name]).join(separator);
    const originalBytes = utf8ByteLength(originalText);
    let available = Math.min(itemLimit, remaining(category));
    const pieces = [];
    const capturedFields = {};
    let hasPreviousField = false;
    let contentBytes = 0;
    let stopped = false;

    for (const name of names) {
      if (stopped) {
        capturedFields[name] = '';
        continue;
      }
      if (hasPreviousField) {
        const separatorBytes = utf8ByteLength(separator);
        if (available < separatorBytes) {
          capturedFields[name] = '';
          stopped = true;
          continue;
        }
        pieces.push(separator);
        available -= separatorBytes;
        contentBytes += separatorBytes;
      }
      const field = truncateUtf8(normalized[name], available);
      capturedFields[name] = field.text;
      pieces.push(field.text);
      available -= field.byteLength;
      contentBytes += field.byteLength;
      hasPreviousField = true;
      if (field.truncated) stopped = true;
    }

    totalUsed += contentBytes;
    usedByCategory.set(category, (usedByCategory.get(category) || 0) + contentBytes);
    return {
      fields: capturedFields,
      text: pieces.join(''),
      truncated: contentBytes < originalBytes,
      originalBytes,
      contentBytes,
      totalContentBytes: totalUsed,
      categoryContentBytes: usedByCategory.get(category),
    };
  }

  return Object.freeze({
    capture(category, text, itemLimit) {
      const bounded = record(category, { text }, itemLimit);
      return {
        text: bounded.fields.text,
        truncated: bounded.truncated,
        originalBytes: bounded.originalBytes,
        contentBytes: bounded.contentBytes,
        totalContentBytes: bounded.totalContentBytes,
        categoryContentBytes: bounded.categoryContentBytes,
      };
    },
    captureRecord: record,
    snapshot() {
      return { totalContentBytes: totalUsed, categoryContentBytes: Object.fromEntries(usedByCategory) };
    },
  });
}

export function hashGitHubContent(value) {
  return createHash('sha256').update(normalizeGitHubText(value), 'utf8').digest('hex');
}

export function createGitHubRevisionKey({ externalType, externalId, upstreamRevision, contentHash }) {
  if (!['readme', 'commit', 'issue'].includes(externalType)
    || typeof externalId !== 'string' || externalId.length < 1 || externalId.length > 500
    || !(upstreamRevision === undefined || upstreamRevision === null || (typeof upstreamRevision === 'string' && upstreamRevision.length <= 500))
    || typeof contentHash !== 'string' || !/^[a-f\d]{64}$/i.test(contentHash)) {
    throw new TypeError('Valid GitHub source identity, upstream revision, and content hash are required.');
  }
  const identityHash = createHash('sha256').update(externalId, 'utf8').digest('hex');
  const revisionMaterial = `${upstreamRevision || ''}\u0000${contentHash.toLowerCase()}`;
  const revisionHash = createHash('sha256').update(revisionMaterial, 'utf8').digest('hex');
  return `github:v1:${externalType}:${identityHash}:${revisionHash}`;
}
