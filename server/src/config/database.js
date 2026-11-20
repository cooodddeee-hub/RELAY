import mongoose from 'mongoose';

// Keep only in-flight connection attempts here. Once connected, Mongoose's
// connection is reused directly; clearing failures lets a later invocation retry.
const pendingConnections = new WeakMap();

export async function connectDatabase({
  client = mongoose,
  uri = process.env.MONGODB_URI,
  logger = console,
  production = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1',
} = {}) {
  if (typeof uri !== 'string' || !uri.trim()) {
    const error = new Error('MongoDB is not configured on the server.');
    error.code = 'DATABASE_NOT_CONFIGURED';
    throw error;
  }

  client.set('strictQuery', true);
  // Production indexes are created and verified by explicit, target-confirmed
  // migrations. Do not let model compilation race that controlled rollout.
  if (production) client.set('autoIndex', false);
  if (client.connection?.readyState === 1) return client.connection;

  let byUri = pendingConnections.get(client);
  if (!byUri) {
    byUri = new Map();
    pendingConnections.set(client, byUri);
  }
  const existing = byUri.get(uri);
  if (existing) return existing;

  const pending = Promise.resolve().then(() => client.connect(uri));
  byUri.set(uri, pending);
  try {
    const connection = await pending;
    logger.info?.('MongoDB connected');
    return connection;
  } catch (error) {
    throw error;
  } finally {
    if (byUri.get(uri) === pending) byUri.delete(uri);
  }
}
