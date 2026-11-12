const SECRET_ASSIGNMENT_PATTERN = /((?:api[_-]?key|token|secret|password)\s*[:=]\s*)([^\s,;&"']+)/gi;
const SECRET_PATTERNS = [
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED_API_KEY]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]'],
  [/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]'],
  [/((?:authorization|cookie|set-cookie)\s*[:=]\s*)[^\r\n]*/gi, '$1[REDACTED]'],
  [SECRET_ASSIGNMENT_PATTERN, '$1[REDACTED]'],
  [/\bmongodb(?:\+srv)?:\/\/[^\s"']+/gi, '[REDACTED_MONGODB_URI]'],
  [/(https?:\/\/[^\s?]+)\?[^\s]+/gi, '$1?[REDACTED_QUERY]'],
];

export function sanitizeLogText(value) {
  let text = String(value ?? '');
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    if (pattern === SECRET_ASSIGNMENT_PATTERN) {
      text = text.replace(pattern, (match, prefix, value) => `${prefix}${value.startsWith('[REDACTED_') ? value : '[REDACTED]'}`);
    } else text = text.replace(pattern, replacement);
  }
  return text.slice(0, 4000);
}

export function errorDetails(error) {
  return {
    name: sanitizeLogText(error?.name || 'Error'),
    message: sanitizeLogText(error?.message || 'Unknown error'),
    stack: sanitizeLogText(error?.stack || ''),
  };
}

export function logError(operation, error, fields = {}) {
  const status = Number(error?.status ?? error?.statusCode) || undefined;
  console.error(JSON.stringify({
    level: 'error',
    operation: sanitizeLogText(operation),
    ...(status ? { status } : {}),
    ...fields,
    error: errorDetails(error),
  }));
}
