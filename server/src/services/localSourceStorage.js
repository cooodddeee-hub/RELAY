import fs from 'node:fs/promises';

export class LocalSourceUnavailableError extends Error {
  constructor() {
    super('The original local source file is unavailable; its source record was preserved.');
    this.name = 'LocalSourceUnavailableError';
    this.status = 410;
  }
}

export function localDiskUploadDisabled(env = process.env) {
  return env.VERCEL === '1' || env.NODE_ENV === 'production';
}

export async function assertLocalSourceAvailable(storagePath, { access = fs.access } = {}) {
  if (!storagePath) throw new LocalSourceUnavailableError();
  try { await access(storagePath); }
  catch { throw new LocalSourceUnavailableError(); }
}

export async function deleteLocalSourceSafely(source, { unlink = fs.unlink } = {}) {
  if (!source?.storagePath) throw new LocalSourceUnavailableError();
  try { await unlink(source.storagePath); }
  catch (error) { if (error?.code === 'ENOENT') throw new LocalSourceUnavailableError(); throw error; }
  await source.deleteOne();
}
