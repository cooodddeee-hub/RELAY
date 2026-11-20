import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { runPhase1HandoverVersionMigration } from '../scripts/migrations/phase1-handover-version-index.js';
import { runPhase2AssignmentIndexMigration } from '../scripts/migrations/phase2-active-assignment-index.js';
import { runPhase3RepositoryIndexMigration } from '../scripts/migrations/phase3-repository-soft-unlink-index.js';
import { runPhase4GitHubSyncIndexMigration } from '../scripts/migrations/phase4-github-sync-indexes.js';
import { runPhase5ProductionModelIndexMigration } from '../scripts/migrations/phase5-production-model-indexes.js';

const uri = process.env.RELAY_TEST_MONGODB_URI;
const options = uri ? { skip: false } : { skip: 'Set RELAY_TEST_MONGODB_URI to the isolated local replica-set database.' };

function assertIsolatedTestTarget(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('The migration test URI must be valid.'); }
  if (parsed.protocol !== 'mongodb:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)
    || parsed.port !== '27018' || decodeURIComponent(parsed.pathname.slice(1)) !== 'relay_round3_test'
    || parsed.searchParams.get('replicaSet') !== 'rs0') {
    throw new Error('Migration integration tests only permit 127.0.0.1:27018/relay_round3_test on replica set rs0.');
  }
}

const migrations = [
  {
    id: 'PHASE1_HANDOVER_VERSION_INDEX',
    expectedKey: 'PHASE1_MIGRATION_EXPECT_DATABASE',
    confirmationKey: 'PHASE1_MIGRATION_CONFIRM_TARGET',
    run: runPhase1HandoverVersionMigration,
  },
  {
    id: 'PHASE2_ACTIVE_ASSIGNMENT_INDEX',
    expectedKey: 'PHASE2_MIGRATION_EXPECT_DATABASE',
    confirmationKey: 'PHASE2_MIGRATION_CONFIRM_TARGET',
    run: runPhase2AssignmentIndexMigration,
  },
  {
    id: 'PHASE3_REPOSITORY_SOFT_UNLINK_INDEX',
    expectedKey: 'PHASE3_MIGRATION_EXPECT_DATABASE',
    confirmationKey: 'PHASE3_MIGRATION_CONFIRM_TARGET',
    run: runPhase3RepositoryIndexMigration,
  },
  {
    id: 'PHASE4_GITHUB_SYNC_INDEXES',
    expectedKey: 'PHASE4_MIGRATION_EXPECT_DATABASE',
    confirmationKey: 'PHASE4_MIGRATION_CONFIRM_TARGET',
    run: runPhase4GitHubSyncIndexMigration,
  },
  {
    id: 'PHASE5_PRODUCTION_MODEL_INDEXES',
    expectedKey: 'PHASE5_MIGRATION_EXPECT_DATABASE',
    confirmationKey: 'PHASE5_MIGRATION_CONFIRM_TARGET',
    run: runPhase5ProductionModelIndexMigration,
  },
];

function envFor(migration) {
  return {
    MONGODB_URI: uri,
    [migration.expectedKey]: 'relay_round3_test',
    [migration.confirmationKey]: `APPLY_${migration.id}:relay_round3_test`,
    ...(migration.id === 'PHASE3_REPOSITORY_SOFT_UNLINK_INDEX'
      ? { PHASE3_MIGRATION_CONFIRM_CHANGES: 'APPLY_PHASE3_REPOSITORY_SOFT_UNLINK_CHANGES:relay_round3_test' }
      : {}),
  };
}

async function getIndexSnapshot() {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 3000 });
  try {
    const names = await mongoose.connection.db.listCollections().toArray();
    const snapshot = {};
    for (const { name } of names) {
      snapshot[name] = (await mongoose.connection.db.collection(name).indexes())
        .map(({ name: indexName, key, unique, partialFilterExpression }) => ({ indexName, key, unique, partialFilterExpression }));
    }
    return snapshot;
  } finally { await mongoose.disconnect(); }
}

test('all five migrations dry-run and apply idempotently on the isolated local replica set', { ...options, timeout: 60_000 }, async () => {
  assertIsolatedTestTarget(uri);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 3000 });
  try {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    assert.equal(hello.setName, 'rs0');
    assert.notEqual(hello.isWritablePrimary, false);
  } finally { await mongoose.disconnect(); }

  for (const migration of migrations) {
    const env = envFor(migration);
    const beforeDryRun = await getIndexSnapshot();
    const preview = await migration.run({ env, dryRun: true });
    assert.equal(preview.targetDatabase, 'relay_round3_test');
    assert.equal(preview.dryRun, true);
    assert.deepEqual(await getIndexSnapshot(), beforeDryRun, `${migration.id} dry-run changed indexes`);

    const first = await migration.run({ env });
    assert.equal(first.applied, true);
    const second = await migration.run({ env });
    assert.equal(second.applied, true);
    assert.equal(second.indexesToCreate?.length || Object.values(second.indexes || {}).reduce((sum, plan) => sum + plan.indexesToCreate.length, 0), 0,
      `${migration.id} was not idempotent on its second apply`);
    if (migration.id === 'PHASE5_PRODUCTION_MODEL_INDEXES') {
      const verification = await migration.run({ env, verifyOnly: true });
      assert.equal(verification.verified, true);
      assert.deepEqual(verification.indexesToCreate, []);
      assert.deepEqual(verification.indexesToChange, []);
    }
  }
});
