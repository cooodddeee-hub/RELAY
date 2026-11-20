export const STARTUP_SPLASH_MIN_MS = 900;

export async function resolveInitialRoute({ token, restoreSession }) {
  if (!token) return { screen: 'login', user: null, error: null };
  try {
    const user = await restoreSession(token);
    return user
      ? { screen: 'app', user, error: null }
      : { screen: 'login', user: null, error: null };
  } catch (error) {
    return { screen: 'login', user: null, error };
  }
}

export function remainingSplashTime(startedAt, now = performance.now(), minimumMs = STARTUP_SPLASH_MIN_MS) {
  return Math.max(0, minimumMs - Math.max(0, now - startedAt));
}
