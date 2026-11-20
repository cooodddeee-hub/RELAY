import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMigrationTarget, countDuplicateKeys, planIndexChanges } from '../src/services/phase4MigrationPreflight.js';
import { runPhase1HandoverVersionMigration } from '../scripts/migrations/phase1-handover-version-index.js';
import { runPhase2AssignmentIndexMigration } from '../scripts/migrations/phase2-active-assignment-index.js';
import { runPhase3RepositoryIndexMigration } from '../scripts/migrations/phase3-repository-soft-unlink-index.js';
import { runPhase4GitHubSyncIndexMigration } from '../scripts/migrations/phase4-github-sync-indexes.js';
import { productionModelIndexDefinitions, runPhase5ProductionModelIndexMigration } from '../scripts/migrations/phase5-production-model-indexes.js';

const uri = 'mongodb://migration-user:private-password@127.0.0.1:27018/relay_round3_test?replicaSet=rs0';
const databaseName = 'relay_round3_test';
const migrationDefinitions = [
  {
    id: 'PHASE1_HANDOVER_VERSION_INDEX',
    envKeys: ['PHASE1_MIGRATION_EXPECT_DATABASE', 'PHASE1_MIGRATION_CONFIRM_TARGET'],
    run: runPhase1HandoverVersionMigration,
  },
  {
    id: 'PHASE2_ACTIVE_ASSIGNMENT_INDEX',
    envKeys: ['PHASE2_MIGRATION_EXPECT_DATABASE', 'PHASE2_MIGRATION_CONFIRM_TARGET'],
    run: runPhase2AssignmentIndexMigration,
  },
  {
    id: 'PHASE3_REPOSITORY_SOFT_UNLINK_INDEX',
    envKeys: ['PHASE3_MIGRATION_EXPECT_DATABASE', 'PHASE3_MIGRATION_CONFIRM_TARGET'],
    run: runPhase3RepositoryIndexMigration,
  },
  {
    id: 'PHASE4_GITHUB_SYNC_INDEXES',
    envKeys: ['PHASE4_MIGRATION_EXPECT_DATABASE', 'PHASE4_MIGRATION_CONFIRM_TARGET'],
    run: runPhase4GitHubSyncIndexMigration,
  },
  {
    id: 'PHASE5_PRODUCTION_MODEL_INDEXES',
    envKeys: ['PHASE5_MIGRATION_EXPECT_DATABASE', 'PHASE5_MIGRATION_CONFIRM_TARGET'],
    run: runPhase5ProductionModelIndexMigration,
  },
];

function environmentFor(definition, overrides = {}) {
  return {
    MONGODB_URI: uri,
    [definition.envKeys[0]]: databaseName,
    [definition.envKeys[1]]: `APPLY_${definition.id}:${databaseName}`,
    ...(definition.id === 'PHASE3_REPOSITORY_SOFT_UNLINK_INDEX'
      ? { PHASE3_MIGRATION_CONFIRM_CHANGES: `APPLY_PHASE3_REPOSITORY_SOFT_UNLINK_CHANGES:${databaseName}` }
      : {}),
    ...overrides,
  };
}

function fakeClient({ duplicateCollection, writeLog = [], indexesByCollection = {} } = {}) {
  const db = {
    collection(name) {
      return {
        aggregate() {
          return { toArray: async () => name === duplicateCollection
            ? [{ _id: {}, duplicateKeyCount: 1, duplicateRecordCount: 2, extraRecordCount: 1 }]
            : [] };
        },
        indexes: async () => indexesByCollection[name] || [],
        countDocuments: async () => 0,
        createIndex: async () => { writeLog.push(`createIndex:${name}`); },
        updateMany: async () => { writeLog.push(`updateMany:${name}`); },
        dropIndex: async () => { writeLog.push(`dropIndex:${name}`); },
      };
    },
    createCollection: async (name) => { writeLog.push(`createCollection:${name}`); },
  };
  const client = {
    connection: { readyState: 0, db, collection: db.collection.bind(db) },
    connect: async (connectedUri) => { client.connectedUri = connectedUri; client.connection.readyState = 1; },
    disconnect: async () => { client.connection.readyState = 0; },
  };
  return client;
}

test('every migration target requires an exact database name, matching dbName override, and phase-specific confirmation', async () => {
  for (const definition of migrationDefinitions) {
    const client = fakeClient();
    const goodEnv = environmentFor(definition);
    await assert.rejects(definition.run({ env: { ...goodEnv, [definition.envKeys[0]]: undefined }, client, dryRun: true }));
    assert.equal(client.connectedUri, undefined, `${definition.id} connected before expected database validation`);
    await assert.rejects(definition.run({ env: { ...goodEnv, [definition.envKeys[1]]: undefined }, client, dryRun: true }));
    await assert.rejects(definition.run({ env: { ...goodEnv, [definition.envKeys[0]]: 'wrong_database' }, client, dryRun: true }));
    await assert.rejects(definition.run({ env: { ...goodEnv, MONGODB_URI: `${uri}&dbName=wrong_database` }, client, dryRun: true }));
  }
  assert.throws(() => validateMigrationTarget({
    uri: 'mongodb://127.0.0.1:27018/relay_round3_test?dbName=admin',
    expectedDatabase: databaseName,
    confirmation: `APPLY_PHASE1_HANDOVER_VERSION_INDEX:${databaseName}`,
    migrationId: 'PHASE1_HANDOVER_VERSION_INDEX',
  }), /dbName override/);
});

test('Phase 3 apply requires separate structural-change confirmation before connecting', async () => {
  const definition = migrationDefinitions[2];
  const client = fakeClient();
  const env = environmentFor(definition);
  delete env.PHASE3_MIGRATION_CONFIRM_CHANGES;
  await assert.rejects(definition.run({ env, client } ), /additional confirmation|explicit confirmation/);
  assert.equal(client.connectedUri, undefined);
});

test('Phase 5 duplicate preflight covers all newly enforced unique constraints before writes', async () => {
  const duplicates = {
    users: 'users', findings: 'findings', contradictioncandidates: 'contradictioncandidates',
    githubinstallstates: 'githubinstallstates', githubinstallations: 'githubinstallations',
    projectdeletionjobs: 'projectdeletionjobs', handoversignoffs: 'handoversignoffs',
  };
  for (const [collection, _label] of Object.entries(duplicates)) {
    const writes = [];
    const client = fakeClient({ duplicateCollection: collection, writeLog: writes });
    await assert.rejects(runPhase5ProductionModelIndexMigration({ env: environmentFor(migrationDefinitions[4]), client }), { code: 'MIGRATION_DUPLICATES' });
    assert.deepEqual(writes, [], `${collection} duplicate preflight must happen before every index write`);
  }
});

test('duplicate counts are aggregated without returning duplicate record identifiers', async () => {
  let pipeline;
  const result = await countDuplicateKeys({
    aggregate(value) { pipeline = value; return { toArray: async () => [{ _id: null, duplicateKeyCount: 2, duplicateRecordCount: 5, extraRecordCount: 3 }] }; },
  }, { fields: ['project', 'version'] });
  assert.deepEqual(result, { duplicateKeyCount: 2, duplicateRecordCount: 5, extraRecordCount: 3 });
  assert.ok(!JSON.stringify(pipeline).includes('ids'));
});

test('index preflight treats sparse and TTL options as critical index semantics', () => {
  const sparseConflict = planIndexChanges(
    [{ name: 'analysisKey_1', key: { analysisKey: 1 }, unique: true }],
    [{ keys: { analysisKey: 1 }, options: { unique: true, sparse: true, name: 'analysisKey_1' } }],
  );
  assert.equal(sparseConflict.indexesToChange.length, 1);
  const ttlConflict = planIndexChanges(
    [{ name: 'expiresAt_1', key: { expiresAt: 1 } }],
    [{ keys: { expiresAt: 1 }, options: { expireAfterSeconds: 0, name: 'expiresAt_1' } }],
  );
  assert.equal(ttlConflict.indexesToChange.length, 1);
});

test('dry-run for all phases reports intended index work and performs zero writes', async () => {
  for (const definition of migrationDefinitions) {
    const writes = [];
    const client = fakeClient({ writeLog: writes });
    const report = await definition.run({ env: environmentFor(definition), client, dryRun: true });
    assert.equal(client.connectedUri, uri, `${definition.id} did not connect using the validated URI unchanged`);
    assert.equal(report.targetDatabase, databaseName);
    assert.equal(report.dryRun, true);
    assert.ok(report.duplicateSummaries);
    assert.deepEqual(writes, []);
    assert.ok(report.indexesToCreate || report.indexes, `${definition.id} omitted planned index changes`);
  }
});

test('Phase 5 verification reports missing indexes and passes only on the complete manifest', async () => {
  const writes = [];
  const missingClient = fakeClient({ writeLog: writes });
  await assert.rejects(runPhase5ProductionModelIndexMigration({ env: environmentFor(migrationDefinitions[4]), client: missingClient, verifyOnly: true }), (error) => (
    error.code === 'MIGRATION_INDEXES_MISSING' && error.report.indexesToCreate.length > 0
  ));
  assert.deepEqual(writes, []);

  const indexesByCollection = Object.fromEntries(productionModelIndexDefinitions.map((definition) => [
    definition.name,
    definition.indexes.map(({ keys, options }) => ({
      name: options.name,
      key: keys,
      unique: Boolean(options.unique),
      sparse: Boolean(options.sparse),
      partialFilterExpression: options.partialFilterExpression,
      expireAfterSeconds: options.expireAfterSeconds,
    })),
  ]));
  const completeClient = fakeClient({ writeLog: writes, indexesByCollection });
  const verified = await runPhase5ProductionModelIndexMigration({ env: environmentFor(migrationDefinitions[4]), client: completeClient, verifyOnly: true });
  assert.equal(verified.verified, true);
  assert.deepEqual(verified.indexesToCreate, []);
  assert.deepEqual(writes, []);
});

test('Phase 5 manifest covers every declared Mongoose model index', async () => {
  const modelFiles = [
    'AnalysisJob.js', 'AuditEvent.js', 'ContradictionCandidate.js', 'Finding.js', 'GitHubInstallState.js',
    'GitHubInstallation.js', 'GitHubSyncJob.js', 'Handover.js', 'HandoverSignoff.js', 'ProjectAssignment.js',
    'ProjectDeletionJob.js', 'ProjectRepository.js', 'ReviewHistory.js', 'Source.js', 'SourceRevision.js', 'User.js',
  ];
  const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
    return value;
  };
  for (const filename of modelFiles) {
    const Model = (await import(`../src/models/${filename}`)).default;
    const collection = Model.collection.collectionName;
    const definition = productionModelIndexDefinitions.find((item) => item.name === collection);
    assert.ok(definition, `${filename} collection ${collection} must be in the production index manifest`);
    for (const [keys, options] of Model.schema.indexes()) {
      const match = definition.indexes.some((index) => JSON.stringify(stable(index.keys)) === JSON.stringify(stable(keys))
        && Boolean(index.options.unique) === Boolean(options.unique)
        && Boolean(index.options.sparse) === Boolean(options.sparse)
        && JSON.stringify(stable(index.options.partialFilterExpression || null)) === JSON.stringify(stable(options.partialFilterExpression || null))
        && (index.options.expireAfterSeconds ?? null) === (options.expireAfterSeconds ?? null));
      assert.ok(match, `${filename} index ${JSON.stringify(keys)} must have equivalent unique/sparse/partial/TTL semantics in Phase 5`);
    }
  }
});

test('duplicate preflight aborts all migration phases before any writes', async () => {
  const duplicateCollections = {
    PHASE1_HANDOVER_VERSION_INDEX: 'handovers',
    PHASE2_ACTIVE_ASSIGNMENT_INDEX: 'projectassignments',
    PHASE3_REPOSITORY_SOFT_UNLINK_INDEX: 'projectrepositories',
    PHASE4_GITHUB_SYNC_INDEXES: 'sourcerevisions',
    PHASE5_PRODUCTION_MODEL_INDEXES: 'githubinstallstates',
  };
  for (const definition of migrationDefinitions) {
    const writes = [];
    const client = fakeClient({ duplicateCollection: duplicateCollections[definition.id], writeLog: writes });
    await assert.rejects(definition.run({ env: environmentFor(definition), client }), (error) => (
      error.code === (definition.id === 'PHASE4_GITHUB_SYNC_INDEXES' ? 'PHASE4_MIGRATION_DUPLICATES' : 'MIGRATION_DUPLICATES')
    ));
    assert.deepEqual(writes, []);
  }
});

test('Phase 3 duplicate preflight precedes collection, status, index, and legacy-index changes', async () => {
  const writes = [];
  const client = fakeClient({ duplicateCollection: 'projectrepositories', writeLog: writes });
  await assert.rejects(runPhase3RepositoryIndexMigration({ env: environmentFor(migrationDefinitions[2]), client }), { code: 'MIGRATION_DUPLICATES' });
  assert.deepEqual(writes, []);
});

test('Phase 3 dry-run reports legacy index removal and status backfill without applying either', async () => {
  const writes = [];
  const client = fakeClient({ writeLog: writes });
  const originalCollection = client.connection.db.collection;
  client.connection.db.collection = (name) => {
    const collection = originalCollection(name);
    if (name === 'projectrepositories') {
      collection.indexes = async () => [
        { name: '_id_', key: { _id: 1 } },
        { name: 'legacy_project_repository_unique', key: { project: 1, repositoryId: 1 }, unique: true },
      ];
      collection.countDocuments = async () => 3;
    }
    return collection;
  };
  client.connection.collection = client.connection.db.collection.bind(client.connection.db);
  const report = await runPhase3RepositoryIndexMigration({ env: environmentFor(migrationDefinitions[2]), client, dryRun: true });
  assert.equal(report.legacyLinksToActivate, 3);
  assert.deepEqual(report.indexesToDrop, [{ name: 'legacy_project_repository_unique', key: { project: 1, repositoryId: 1 } }]);
  assert.ok(report.indexesToCreate.some((index) => index.name === 'active_project_repository_unique'));
  assert.deepEqual(writes, []);
});
