const RETENTION_ENV_KEYS = Object.freeze({
  audit: 'AUDIT_RETENTION_DAYS',
  signoff: 'SIGNOFF_RETENTION_DAYS',
});

export function retentionExpiry(kind, { now = new Date(), env = process.env } = {}) {
  const key = RETENTION_ENV_KEYS[kind];
  if (!key) throw new TypeError('Unknown retention category.');
  const rawDays = env[key];
  if (typeof rawDays !== 'string' || !/^\d+$/.test(rawDays) || Number(rawDays) < 1) {
    const error = new Error(`${key} must be configured as a positive whole number of days before retention metadata is written.`);
    error.code = 'RETENTION_CONFIGURATION_INVALID';
    throw error;
  }
  const expiresAt = new Date(now.getTime() + Number(rawDays) * 24 * 60 * 60 * 1000);
  if (!Number.isFinite(expiresAt.getTime())) {
    const error = new Error(`${key} is outside the supported retention range.`);
    error.code = 'RETENTION_CONFIGURATION_INVALID';
    throw error;
  }
  return expiresAt;
}
