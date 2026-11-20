const PLACEHOLDER = /^(?:change[-_ ]?me|replace[-_ ]?me|your[-_ ].*|secret|changethis)(?:$|[-_ ].*)/i;

export function validateJwtSecret(secret, { production = false } = {}) {
  if (typeof secret !== 'string' || !secret.trim()) {
    if (!production) return { valid: true, configured: false };
    throw new Error('JWT_SECRET is required in production.');
  }
  const bytes = Buffer.byteLength(secret, 'utf8');
  if (bytes < 32 || PLACEHOLDER.test(secret.trim()) || /\s/.test(secret.trim())) {
    throw new Error('JWT_SECRET must be a non-placeholder value containing at least 32 UTF-8 bytes and no whitespace.');
  }
  return { valid: true, configured: true };
}
