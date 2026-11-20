import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthRequest, isRegistrationPasswordValid } from '../src/authFlow.js';

test('sign-in request keeps the existing endpoint and normalized email payload', () => {
  assert.deepEqual(createAuthRequest('login', { email: '  PERSON@Example.com ', password: ' pass ' }), {
    endpoint: '/auth/login', payload: { email: 'person@example.com', password: ' pass ' },
  });
});

test('registration request keeps the existing endpoint, trimmed name and password rule', () => {
  assert.deepEqual(createAuthRequest('register', { email: ' USER@Example.com ', password: 'password', name: '  Relay User  ' }), {
    endpoint: '/auth/register', payload: { email: 'user@example.com', password: 'password', name: 'Relay User' },
  });
  assert.equal(isRegistrationPasswordValid('1234567'), false);
  assert.equal(isRegistrationPasswordValid('12345678'), true);
});
