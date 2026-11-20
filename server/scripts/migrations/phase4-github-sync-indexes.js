import 'dotenv/config';
import mongoose from 'mongoose';
import { pathToFileURL } from 'node:url';
import {
  countDuplicateKeys, createDuplicatePreflightError, planIndexChanges, readIndexes, validatePhase4MigrationTarget,
} from '../../src/services/phase4MigrationPreflight.js';

const migrationId = 'PHASE4_GITHUB_SYNC_INDEXES';
const collections = [
  {
    name: 'sources',
    duplicates: {
      githubSourceIdentity: {
        fields: ['provider', 'repositoryLink', 'externalType', 'externalId'],
        filter: { provider: 'github', repositoryLink: { $exists: true }, externalId: { $exists: true } },
      },
    },
    indexes: [{
      keys: { provider: 1, repositoryLink: 1, externalType: 1, externalId: 1 },
      options: {
        unique: true,
        name: 'provider_1_repositoryLink_1_externalType_1_externalId_1',
        partialFilterExpression: { provider: 'github', repositoryLink: { $exists: true }, externalId: { $exists: true } },
      },
    }],
  },
  {
    name: 'sourcerevisions',
    duplicates: { sourceRevisionKey: { fields: ['source', 'revisionKey'] } },
    indexes: [
      { keys: { source: 1, revisionKey: 1 }, options: { unique: true, name: 'source_1_revisionKey_1' } },
      { keys: { source: 1, capturedAt: -1 }, options: { name: 'source_1_capturedAt_-1' } },
    ],
  },
  {
    name: 'githubsyncjobs',
    duplicates: { activeSyncPerRepositoryLink: { fields: ['repositoryLink', 'active'], filter: { active: true } } },
    indexes: [
      {
        keys: { repositoryLink: 1, active: 1 },
        options: { unique: true, name: 'one_active_github_sync_per_repository_link', partialFilterExpression: { active: true } },
      },
      { keys: { project: 1, createdAt: -1 }, options: { name: 'project_1_createdAt_-1' } },
      { keys: { repositoryLink: 1, createdAt: -1 }, options: { name: 'repositoryLink_1_createdAt_-1' } },
    ],
  },
];

export async function runPhase4GitHubSyncIndexMigration({ env = process.env, client = mongoose, dryRun = false } = {}) {
  const uri = env.MONGODB_URI;
  const target = validatePhase4MigrationTarget({
    uri,
    expectedDatabase: env.PHASE4_MIGRATION_EXPECT_DATABASE,
    confirmation: env.PHASE4_MIGRATION_CONFIRM_TARGET,
  });

  try {
    await client.connect(target.uri);
    const duplicateSummaries = {};
    const indexPlans = {};
    for (const definition of collections) {
      const collection = client.connection.db.collection(definition.name);
      for (const [label, duplicateDefinition] of Object.entries(definition.duplicates)) {
        duplicateSummaries[label] = await countDuplicateKeys(collection, duplicateDefinition);
      }
      indexPlans[definition.name] = planIndexChanges(await readIndexes(collection), definition.indexes);
    }
    const report = {
      migrationId,
      targetDatabase: target.databaseName,
      dryRun,
      duplicateSummaries,
      indexes: indexPlans,
    };
    const duplicateError = createDuplicatePreflightError(duplicateSummaries);
    if (duplicateError) { duplicateError.code = 'PHASE4_MIGRATION_DUPLICATES'; duplicateError.report = report; throw duplicateError; }
    const conflicts = Object.entries(indexPlans).flatMap(([name, plan]) => plan.indexesToChange.map((item) => ({ collection: name, ...item })));
    if (conflicts.length) {
      const error = new Error('Conflicting Phase 4 index definitions must be reviewed before migration.');
      error.code = 'MIGRATION_INDEX_CONFLICT';
      error.report = { ...report, indexesToChange: conflicts };
      throw error;
    }
    if (dryRun) return report;

    for (const definition of collections) {
      const collection = client.connection.db.collection(definition.name);
      const plan = indexPlans[definition.name];
      for (const item of plan.indexesToCreate) {
        const desired = definition.indexes.find((index) => index.options.name === item.name);
        await collection.createIndex(desired.keys, desired.options);
      }
    }
    return { ...report, applied: true };
  } finally {
    if (client.connection?.readyState === 1) await client.disconnect();
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  try {
    const report = await runPhase4GitHubSyncIndexMigration({ dryRun });
    console.info(JSON.stringify(report));
  } catch (error) {
    if (error?.report) console.error(JSON.stringify(error.report));
    console.error(error?.code === 'PHASE4_MIGRATION_DUPLICATES' || error?.code === 'MIGRATION_INDEX_CONFLICT'
      ? error.message
      : error?.message?.startsWith('MONGODB_URI') || error?.message?.startsWith('Expected migration') || error?.message?.startsWith('Migration confirmation')
        ? error.message
        : 'Phase 4 migration failed; database connection details are suppressed.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
