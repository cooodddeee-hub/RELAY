import 'dotenv/config';
import mongoose from 'mongoose';
import { pathToFileURL } from 'node:url';
import {
  countDuplicateKeys, createDuplicatePreflightError, planIndexChanges, readIndexes, validateMigrationTarget,
} from '../../src/services/phase4MigrationPreflight.js';

const migrationId = 'PHASE3_REPOSITORY_SOFT_UNLINK_INDEX';
const expectedIndexes = [{
  keys: { project: 1, repositoryId: 1, status: 1 },
  options: { unique: true, name: 'active_project_repository_unique', partialFilterExpression: { status: 'active' } },
}];
const isLegacyUniqueIndex = (index) => {
  const keys = Object.keys(index.key || {});
  return Boolean(index.unique) && keys.length === 2 && keys[0] === 'project' && keys[1] === 'repositoryId';
};

export async function runPhase3RepositoryIndexMigration({ env = process.env, client = mongoose, dryRun = false } = {}) {
  const target = validateMigrationTarget({
    uri: env.MONGODB_URI,
    expectedDatabase: env.PHASE3_MIGRATION_EXPECT_DATABASE,
    confirmation: env.PHASE3_MIGRATION_CONFIRM_TARGET,
    migrationId,
  });
  if (!dryRun && env.PHASE3_MIGRATION_CONFIRM_CHANGES !== `APPLY_PHASE3_REPOSITORY_SOFT_UNLINK_CHANGES:${target.databaseName}`) {
    throw new Error('Phase 3 apply requires explicit confirmation of repository status migration and legacy index removal.');
  }

  try {
    await client.connect(target.uri);
    const database = client.connection.db;
    const repositories = database.collection('projectrepositories');
    const duplicateSummaries = {
      activeProjectRepositories: await countDuplicateKeys(repositories, {
        fields: ['project', 'repositoryId'],
        filter: { $or: [{ status: 'active' }, { status: { $exists: false } }] },
      }),
    };
    const indexes = await readIndexes(repositories);
    const indexPlan = planIndexChanges(indexes, expectedIndexes, { drop: [isLegacyUniqueIndex] });
    const legacyLinksToActivate = await repositories.countDocuments({ status: { $exists: false } });
    const report = {
      migrationId,
      targetDatabase: target.databaseName,
      dryRun,
      duplicateSummaries,
      legacyLinksToActivate,
      collectionWouldBeCreated: indexes.length === 0,
      ...indexPlan,
    };
    const duplicateError = createDuplicatePreflightError(duplicateSummaries);
    if (duplicateError) { duplicateError.report = report; throw duplicateError; }
    if (indexPlan.indexesToChange.length) {
      const error = new Error('A conflicting repository index must be reviewed before migration.');
      error.code = 'MIGRATION_INDEX_CONFLICT';
      error.report = report;
      throw error;
    }
    if (dryRun) return report;

    if (indexes.length === 0) await database.createCollection('projectrepositories');
    for (const index of indexPlan.indexesToCreate) {
      const desired = expectedIndexes.find((entry) => entry.options.name === index.name);
      await repositories.createIndex(desired.keys, desired.options);
    }
    if (legacyLinksToActivate) {
      await repositories.updateMany({ status: { $exists: false } }, { $set: { status: 'active' } });
    }
    for (const index of indexPlan.indexesToDrop) await repositories.dropIndex(index.name);
    return { ...report, applied: true };
  } finally {
    if (client.connection?.readyState === 1) await client.disconnect();
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  try {
    const report = await runPhase3RepositoryIndexMigration({ dryRun });
    console.info(JSON.stringify(report));
  } catch (error) {
    if (error?.report) console.error(JSON.stringify(error.report));
    console.error(error?.code === 'MIGRATION_DUPLICATES' || error?.code === 'MIGRATION_INDEX_CONFLICT'
      ? error.message
      : error?.message?.startsWith('MONGODB_URI') || error?.message?.startsWith('Expected migration') || error?.message?.startsWith('Migration confirmation') || error?.message?.startsWith('Phase 3 apply requires')
        ? error.message
        : 'Phase 3 migration failed; database connection details are suppressed.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
