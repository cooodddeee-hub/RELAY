export function createAuthRequest(mode, { email, password, name } = {}) {
  const registering = mode === 'register';
  const payload = {
    email: String(email || '').trim().toLowerCase(),
    password: String(password || ''),
  };
  if (registering) payload.name = String(name || '').trim();
  return { endpoint: `/auth/${registering ? 'register' : 'login'}`, payload };
}

export function isRegistrationPasswordValid(password) {
  return typeof password === 'string' && password.length >= 8;
}
