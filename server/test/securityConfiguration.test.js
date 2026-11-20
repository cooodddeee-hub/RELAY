import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { createAuthRateLimits } from '../src/middleware/authRateLimits.js';
import { validateJwtSecret } from '../src/config/jwtSecret.js';

test('JWT startup validation requires a long non-placeholder production secret without disclosing it', () => {
  assert.throws(() => validateJwtSecret(undefined, { production: true }), /JWT_SECRET is required/);
  assert.throws(() => validateJwtSecret('short', { production: true }), /at least 32/);
  assert.throws(() => validateJwtSecret('change-me-change-me-change-me-123', { production: true }), /non-placeholder/);
  assert.deepEqual(validateJwtSecret('a'.repeat(40), { production: true }), { valid: true, configured: true });
  assert.deepEqual(validateJwtSecret(undefined), { valid: true, configured: false });
});

test('login and registration have distinct authentication request limits', async () => {
  const app = express();
  const limits = createAuthRateLimits({ windowMs: 60_000, max: 2, standardHeaders: false });
  app.post('/login', limits.login, (_req, res) => res.sendStatus(204));
  app.post('/register', limits.register, (_req, res) => res.sendStatus(204));
  const server = createServer(app); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (let index = 0; index < 2; index += 1) assert.equal((await fetch(`${base}/login`, { method: 'POST' })).status, 204);
    assert.equal((await fetch(`${base}/login`, { method: 'POST' })).status, 429);
    assert.equal((await fetch(`${base}/register`, { method: 'POST' })).status, 204);
  } finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
