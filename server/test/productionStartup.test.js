import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('production app startup does not require or create a local uploads directory', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'relay-vercel-startup-'));
  const appPath = fileURLToPath(new URL('../src/app.js', import.meta.url));
  const script = `await import(${JSON.stringify(pathToFileURL(appPath).href)});`;
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd,
      env: { ...process.env, VERCEL: '1', NODE_ENV: 'production' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(access(path.join(cwd, 'uploads')), { code: 'ENOENT' });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
