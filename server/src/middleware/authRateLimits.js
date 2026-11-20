import rateLimit from 'express-rate-limit';

// Authentication endpoints need tighter limits than ordinary API traffic.
// The default in-memory store is per process; production deployments should
// use a shared store if traffic is spread across multiple instances.
export function createAuthRateLimits(options = {}) {
  const common = {
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { message: 'Too many authentication attempts. Please try again later.' },
    ...options,
  };
  return {
    login: rateLimit({ windowMs: 15 * 60 * 1000, max: 10, ...common }),
    register: rateLimit({ windowMs: 60 * 60 * 1000, max: 5, ...common }),
  };
}

const limits = createAuthRateLimits();
export const loginRateLimit = limits.login;
export const registerRateLimit = limits.register;
