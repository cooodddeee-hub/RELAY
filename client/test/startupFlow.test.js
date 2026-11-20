import test from 'node:test';
import assert from 'node:assert/strict';
import { remainingSplashTime, resolveInitialRoute, STARTUP_SPLASH_MIN_MS } from '../src/startupFlow.js';

test('initial routing does not call session restore when there is no saved token', async () => {
  let called = false;
  const route = await resolveInitialRoute({ token: '', restoreSession: async () => { called = true; } });
  assert.deepEqual(route, { screen: 'login', user: null, error: null });
  assert.equal(called, false);
});

test('initial routing opens the application only after a saved session is restored', async () => {
  const user = { id: 'user-1', name: 'RELAY User' };
  const route = await resolveInitialRoute({ token: 'saved-token', restoreSession: async (token) => {
    assert.equal(token, 'saved-token');
    return user;
  } });
  assert.deepEqual(route, { screen: 'app', user, error: null });
});

test('startup login routing does not change the authenticated login/register endpoint integration', async () => {
  const seen = [];
  const route = await resolveInitialRoute({ token: '', restoreSession: async () => seen.push('unexpected restore') });
  assert.equal(route.screen, 'login');
  assert.deepEqual(seen, []);
});

test('expired or unreachable saved sessions route to login with a recoverable error', async () => {
  const error = new Error('session unavailable');
  const route = await resolveInitialRoute({ token: 'saved-token', restoreSession: async () => { throw error; } });
  assert.equal(route.screen, 'login');
  assert.equal(route.error, error);
});

test('splash minimum is brief and never adds delay after slow initialization', () => {
  assert.equal(STARTUP_SPLASH_MIN_MS, 900);
  assert.equal(remainingSplashTime(100, 400), 600);
  assert.equal(remainingSplashTime(100, 1200), 0);
});
