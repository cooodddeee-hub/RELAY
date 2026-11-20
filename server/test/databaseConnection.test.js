import test from 'node:test';
import assert from 'node:assert/strict';
import { connectDatabase } from '../src/config/database.js';

function fakeClient(connect) {
  return {
    connection: { readyState: 0 },
    settings: {},
    set(key, value) { this.settings[key] = value; },
    connect,
  };
}

test('reuses an already connected Mongoose connection', async () => {
  let calls = 0;
  const client = fakeClient(async () => { calls += 1; });
  client.connection.readyState = 1;
  const result = await connectDatabase({ client, uri: 'mongodb://placeholder', logger: {} });
  assert.equal(result, client.connection);
  assert.equal(calls, 0);
});

test('production database connections disable automatic schema index creation', async () => {
  const client = fakeClient(async () => { client.connection.readyState = 1; });
  await connectDatabase({ client, uri: 'mongodb://placeholder', logger: {}, production: true });
  assert.equal(client.settings.autoIndex, false);
});

test('shares one in-flight initialization between concurrent callers', async () => {
  let calls = 0;
  let resolveConnect;
  const client = fakeClient(() => {
    calls += 1;
    return new Promise((resolve) => { resolveConnect = () => { client.connection.readyState = 1; resolve(); }; });
  });
  const options = { client, uri: 'mongodb://placeholder', logger: {} };
  const first = connectDatabase(options);
  const second = connectDatabase(options);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  resolveConnect();
  await Promise.all([first, second]);
  assert.equal(client.connection.readyState, 1);
});

test('clears a rejected initialization so a later request can recover', async () => {
  let calls = 0;
  const client = fakeClient(async () => {
    calls += 1;
    if (calls === 1) throw new Error('connection failed');
    client.connection.readyState = 1;
  });
  const options = { client, uri: 'mongodb://placeholder', logger: {} };
  await assert.rejects(connectDatabase(options), /connection failed/);
  await connectDatabase(options);
  assert.equal(calls, 2);
  assert.equal(client.connection.readyState, 1);
});
