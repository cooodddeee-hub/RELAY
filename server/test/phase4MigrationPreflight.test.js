import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNoDuplicateKeys, validatePhase4MigrationTarget } from '../src/services/phase4MigrationPreflight.js';
import { runPhase4GitHubSyncIndexMigration } from '../scripts/migrations/phase4-github-sync-indexes.js';

const validTarget = {
  uri: 'mongodb://migration-user:private-password@127.0.0.1:27018/relay_round3_test?replicaSet=rs0',
  expectedDatabase: 'relay_round3_test',
  confirmation: 'APPLY_PHASE4_GITHUB_SYNC_INDEXES:relay_round3_test',
};

test('Phase 4 migration target requires an exact named MongoDB database and explicit confirmation', () => {
  assert.deepEqual(validatePhase4MigrationTarget(validTarget), { databaseName: 'relay_round3_test', uri: validTarget.uri });
  const invalidCases = [
    [{ ...validTarget, uri: '' }, /MONGODB_URI is required/],
    [{ ...validTarget, uri: 'https://127.0.0.1/relay_round3_test' }, /MongoDB connection URIs/],
    [{ ...validTarget, uri: 'mongodb://127.0.0.1:27017/' }, /named application database/],
    [{ ...validTarget, uri: 'mongodb://127.0.0.1:27017/relay_round3_test?dbName=admin' }, /path and dbName override/],
    [{ ...validTarget, uri: 'mongodb://127.0.0.1:27017/admin', expectedDatabase: 'admin', confirmation: 'APPLY_PHASE4_GITHUB_SYNC_INDEXES:admin' }, /named application database/],
    [{ ...validTarget, expectedDatabase: 'another_test' }, /must exactly match/],
    [{ ...validTarget, confirmation: 'yes' }, /explicitly confirm/],
  ];
  for (const [input, expected] of invalidCases) {
    assert.throws(() => validatePhase4MigrationTarget(input), expected);
  }
  assert.throws(() => validatePhase4MigrationTarget({ ...validTarget, uri: 'mongodb://migration-user:private-password@127.0.0.1:27018/relay_round3_test', expectedDatabase: 'wrong' }), (error) => (
    !error.message.includes('private-password') && !error.message.includes('mongodb://')
  ));
});

test('migration duplicate preflight builds a filtered compound-key check and stops on duplicates', async () => {
  let recordedPipeline;
  const collection = {
    aggregate(pipeline) {
      recordedPipeline = pipeline;
      return { toArray: async () => [] };
    },
  };
  await assertNoDuplicateKeys(collection, {
    fields: ['provider', 'repositoryLink', 'externalType', 'externalId'],
    filter: { provider: 'github' },
    description: 'GitHub source identity',
  });
  assert.deepEqual(recordedPipeline[0], { $match: { provider: 'github' } });
  assert.deepEqual(recordedPipeline[1].$group._id, {
    provider: '$provider', repositoryLink: '$repositoryLink', externalType: '$externalType', externalId: '$externalId',
  });

  collection.aggregate = () => ({ toArray: async () => [{ _id: null, duplicateKeyCount: 1, duplicateRecordCount: 2, extraRecordCount: 1 }] });
  await assert.rejects(assertNoDuplicateKeys(collection, {
    fields: ['provider'], description: 'GitHub source identity',
  }), { code: 'PHASE4_MIGRATION_DUPLICATES' });
});

test('migration completes all duplicate preflights before any index creation and never writes history', async () => {
  const events = [];
  const collection = (name) => ({
    aggregate: () => ({ toArray: async () => { events.push(`preflight:${name}`); return []; } }),
    createIndex: async (keys, options) => { events.push(`index:${name}:${options.name}`); },
  });
  const fakeClient = {
    connection: { readyState: 0, db: { collection } },
    connect: async () => { events.push('connect'); fakeClient.connection.readyState = 1; },
    disconnect: async () => { events.push('disconnect'); fakeClient.connection.readyState = 0; },
  };
  const result = await runPhase4GitHubSyncIndexMigration({
    env: { MONGODB_URI: validTarget.uri, PHASE4_MIGRATION_EXPECT_DATABASE: validTarget.expectedDatabase, PHASE4_MIGRATION_CONFIRM_TARGET: validTarget.confirmation },
    client: fakeClient,
  });
  assert.equal(result.migrationId, 'PHASE4_GITHUB_SYNC_INDEXES');
  assert.equal(result.targetDatabase, 'relay_round3_test');
  assert.equal(result.applied, true);
  assert.deepEqual(result.duplicateSummaries.githubSourceIdentity, { duplicateKeyCount: 0, duplicateRecordCount: 0, extraRecordCount: 0 });
  assert.ok(result.indexes.sources.indexesToCreate.some((index) => index.name === 'provider_1_repositoryLink_1_externalType_1_externalId_1'));
  const firstIndex = events.findIndex((event) => event.startsWith('index:'));
  assert.ok(events.indexOf('preflight:sources') < firstIndex);
  assert.ok(events.indexOf('preflight:sourcerevisions') < firstIndex);
  assert.ok(events.indexOf('preflight:githubsyncjobs') < firstIndex);
  assert.equal(events.some((event) => event.startsWith('write:')), false);
  assert.equal(events.at(-1), 'disconnect');
});

test('duplicate migration preflight aborts before creating any index', async () => {
  const events = [];
  const fakeClient = {
    connection: { readyState: 0, db: { collection: (name) => ({
      aggregate: () => ({ toArray: async () => {
        events.push(`preflight:${name}`);
        return name === 'sourcerevisions' ? [{ _id: null, duplicateKeyCount: 1, duplicateRecordCount: 2, extraRecordCount: 1 }] : [];
      } }),
      createIndex: async () => events.push('index'),
    }) } },
    connect: async () => { fakeClient.connection.readyState = 1; },
    disconnect: async () => { fakeClient.connection.readyState = 0; events.push('disconnect'); },
  };
  await assert.rejects(runPhase4GitHubSyncIndexMigration({
    env: { MONGODB_URI: validTarget.uri, PHASE4_MIGRATION_EXPECT_DATABASE: validTarget.expectedDatabase, PHASE4_MIGRATION_CONFIRM_TARGET: validTarget.confirmation },
    client: fakeClient,
  }), { code: 'PHASE4_MIGRATION_DUPLICATES' });
  assert.equal(events.includes('index'), false);
  assert.equal(events.at(-1), 'disconnect');
});
