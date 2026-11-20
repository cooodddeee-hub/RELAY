import 'dotenv/config';
import mongoose from 'mongoose';
import { pathToFileURL } from 'node:url';
import {
  countDuplicateKeys, createDuplicatePreflightError, planIndexChanges, readIndexes, validateMigrationTarget,
} from '../../src/services/phase4MigrationPreflight.js';

const migrationId = 'PHASE2_ACTIVE_ASSIGNMENT_INDEX';
const expectedIndexes = [{
  keys: { project: 1, user: 1, role: 1, scopeType: 1, scopeValue: 1 },
  options: { unique: true, name: 'active_assignment_unique', partialFilterExpression: { status: 'active' } },
}];

export async function runPhase2AssignmentIndexMigration({ env = process.env, client = mongoose, dryRun = false } = {}) {
  const target = validateMigrationTarget({
    uri: env.MONGODB_URI,
    expectedDatabase: env.PHASE2_MIGRATION_EXPECT_DATABASE,
    confirmation: env.PHASE2_MIGRATION_CONFIRM_TARGET,
    migrationId,
  });

  try {
    await client.connect(target.uri);
    const assignments = client.connection.collection('projectassignments');
    const duplicateSummaries = {
      activeProjectAssignments: await countDuplicateKeys(assignments, {
        fields: ['project', 'user', 'role', 'scopeType', 'scopeValue'],
        filter: { status: 'active' },
      }),
    };
    const indexPlan = planIndexChanges(await readIndexes(assignments), expectedIndexes);
    const report = { migrationId, targetDatabase: target.databaseName, dryRun, duplicateSummaries, ...indexPlan };
    const duplicateError = createDuplicatePreflightError(duplicateSummaries);
    if (duplicateError) { duplicateError.report = report; throw duplicateError; }
    if (indexPlan.indexesToChange.length) {
      const error = new Error('A conflicting assignment index must be reviewed before migration.');
      error.code = 'MIGRATION_INDEX_CONFLICT';
      error.report = report;
      throw error;
    }
    if (dryRun) return report;

    for (const index of indexPlan.indexesToCreate) {
      const desired = expectedIndexes.find((entry) => entry.options.name === index.name);
      await assignments.createIndex(desired.keys, desired.options);
    }
    return { ...report, applied: true };
  } finally {
    if (client.connection?.readyState === 1) await client.disconnect();
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  try {
    const report = await runPhase2AssignmentIndexMigration({ dryRun });
    console.info(JSON.stringify(report));
  } catch (error) {
    if (error?.report) console.error(JSON.stringify(error.report));
    console.error(error?.code === 'MIGRATION_DUPLICATES' || error?.code === 'MIGRATION_INDEX_CONFLICT'
      ? error.message
      : error?.message?.startsWith('MONGODB_URI') || error?.message?.startsWith('Expected migration') || error?.message?.startsWith('Migration confirmation')
        ? error.message
        : 'Phase 2 migration failed; database connection details are suppressed.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
