import 'dotenv/config';
import mongoose from 'mongoose';
import { pathToFileURL } from 'node:url';
import {
  countDuplicateKeys, createDuplicatePreflightError, planIndexChanges, readIndexes, validateMigrationTarget,
} from '../../src/services/phase4MigrationPreflight.js';

const migrationId = 'PHASE1_HANDOVER_VERSION_INDEX';
const expectedIndexes = [{ keys: { project: 1, version: 1 }, options: { unique: true, name: 'project_1_version_1_unique' } }];

export async function runPhase1HandoverVersionMigration({ env = process.env, client = mongoose, dryRun = false } = {}) {
  const target = validateMigrationTarget({
    uri: env.MONGODB_URI,
    expectedDatabase: env.PHASE1_MIGRATION_EXPECT_DATABASE,
    confirmation: env.PHASE1_MIGRATION_CONFIRM_TARGET,
    migrationId,
  });

  try {
    await client.connect(target.uri);
    const handovers = client.connection.collection('handovers');
    const duplicateSummaries = {
      handoverProjectVersion: await countDuplicateKeys(handovers, { fields: ['project', 'version'] }),
    };
    const indexPlan = planIndexChanges(await readIndexes(handovers), expectedIndexes);
    const report = { migrationId, targetDatabase: target.databaseName, dryRun, duplicateSummaries, ...indexPlan };
    const duplicateError = createDuplicatePreflightError(duplicateSummaries);
    if (duplicateError) { duplicateError.report = report; throw duplicateError; }
    if (indexPlan.indexesToChange.length) {
      const error = new Error('A conflicting handover index must be reviewed before migration.');
      error.code = 'MIGRATION_INDEX_CONFLICT';
      error.report = report;
      throw error;
    }
    if (dryRun) return report;

    for (const index of indexPlan.indexesToCreate) {
      const desired = expectedIndexes.find((entry) => entry.options.name === index.name);
      await handovers.createIndex(desired.keys, desired.options);
    }
    return { ...report, applied: true };
  } finally {
    if (client.connection?.readyState === 1) await client.disconnect();
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  try {
    const report = await runPhase1HandoverVersionMigration({ dryRun });
    console.info(JSON.stringify(report));
  } catch (error) {
    if (error?.report) console.error(JSON.stringify(error.report));
    console.error(error?.code === 'MIGRATION_DUPLICATES' || error?.code === 'MIGRATION_INDEX_CONFLICT'
      ? error.message
      : error?.message?.startsWith('MONGODB_URI') || error?.message?.startsWith('Expected migration') || error?.message?.startsWith('Migration confirmation')
        ? error.message
        : 'Phase 1 migration failed; database connection details are suppressed.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
