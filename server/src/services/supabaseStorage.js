import { createClient } from '@supabase/supabase-js';

let cachedClient;

export class SupabaseStorageConfigurationError extends Error {
  constructor() {
    super('Supabase Storage is not configured on the server.');
    this.name = 'SupabaseStorageConfigurationError';
    this.status = 503;
  }
}

export function readSupabaseStorageConfig(env = process.env) {
  const url = typeof env.SUPABASE_URL === 'string' ? env.SUPABASE_URL.trim() : '';
  const secretKey = typeof env.SUPABASE_SECRET_KEY === 'string' ? env.SUPABASE_SECRET_KEY.trim() : '';
  const bucket = typeof env.SUPABASE_STORAGE_BUCKET === 'string' ? env.SUPABASE_STORAGE_BUCKET.trim() : '';
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch { throw new SupabaseStorageConfigurationError(); }
  if (!['https:', 'http:'].includes(parsedUrl.protocol) || !secretKey || !bucket) {
    throw new SupabaseStorageConfigurationError();
  }
  return { url, secretKey, bucket };
}

export function getSupabaseStorage() {
  const config = readSupabaseStorageConfig();
  if (!cachedClient) {
    cachedClient = createClient(config.url, config.secretKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
  }
  return { client: cachedClient, bucket: cachedClient.storage.from(config.bucket), bucketName: config.bucket };
}
