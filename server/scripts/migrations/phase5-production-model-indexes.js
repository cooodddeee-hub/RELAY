import 'dotenv/config';
import mongoose from 'mongoose';
import { pathToFileURL } from 'node:url';
import {
  countDuplicateKeys, createDuplicatePreflightError, planIndexChanges, readIndexes, validateMigrationTarget,
} from '../../src/services/phase4MigrationPreflight.js';

const migrationId = 'PHASE5_PRODUCTION_MODEL_INDEXES';
export const productionModelIndexDefinitions = [
  {
    name: 'users',
    duplicates: { uniqueEmail: { fields: ['email'] } },
    indexes: [{ keys: { email: 1 }, options: { unique: true, name: 'email_1' } }],
  },
  {
    name: 'findings',
    duplicates: { analysisKey: { fields: ['analysisKey'], filter: { analysisKey: { $exists: true } } } },
    indexes: [{ keys: { analysisKey: 1 }, options: { unique: true, sparse: true, name: 'analysisKey_1' } }],
  },
  {
    name: 'analysisjobs',
    indexes: [
      { keys: { project: 1 }, options: { name: 'project_1' } },
      { keys: { status: 1 }, options: { name: 'status_1' } },
      { keys: { project: 1, createdAt: -1 }, options: { name: 'project_1_createdAt_-1' } },
    ],
  },
  {
    name: 'auditevents',
    indexes: [
      { keys: { projectId: 1, createdAt: -1 }, options: { name: 'projectId_1_createdAt_-1' } },
      { keys: { targetType: 1, targetId: 1, createdAt: 1 }, options: { name: 'targetType_1_targetId_1_createdAt_1' } },
      { keys: { expiresAt: 1 }, options: { expireAfterSeconds: 0, name: 'expiresAt_1' } },
    ],
  },
  {
    name: 'contradictioncandidates',
    duplicates: { projectCandidateKey: { fields: ['project', 'candidateKey'] } },
    indexes: [
      { keys: { project: 1, candidateKey: 1 }, options: { unique: true, name: 'project_1_candidateKey_1' } },
      { keys: { project: 1, status: 1, createdAt: -1 }, options: { name: 'project_1_status_1_createdAt_-1' } },
      { keys: { 'evidence.sourceRevision': 1 }, options: { name: 'evidence.sourceRevision_1' } },
    ],
  },
  {
    name: 'githubinstallstates',
    duplicates: { stateHash: { fields: ['stateHash'] } },
    indexes: [
      { keys: { stateHash: 1 }, options: { unique: true, name: 'stateHash_1' } },
      { keys: { expiresAt: 1 }, options: { expireAfterSeconds: 0, name: 'expiresAt_1' } },
    ],
  },
  {
    name: 'githubinstallations',
    duplicates: { installationId: { fields: ['installationId'] } },
    indexes: [
      { keys: { installationId: 1 }, options: { unique: true, name: 'installationId_1' } },
      { keys: { authorizedUsers: 1, status: 1 }, options: { name: 'authorizedUsers_1_status_1' } },
    ],
  },
  {
    name: 'projectdeletionjobs',
    duplicates: { projectId: { fields: ['projectId'] } },
    indexes: [
      { keys: { projectId: 1 }, options: { unique: true, name: 'projectId_1' } },
      { keys: { status: 1, nextAttemptAt: 1 }, options: { name: 'status_1_nextAttemptAt_1' } },
      { keys: { status: 1, leaseExpiresAt: 1 }, options: { name: 'status_1_leaseExpiresAt_1' } },
    ],
  },
  {
    name: 'handovers',
    duplicates: { projectVersion: { fields: ['project', 'version'] } },
    indexes: [
      { keys: { project: 1 }, options: { name: 'project_1' } },
      { keys: { project: 1, version: 1 }, options: { unique: true, name: 'project_1_version_1' } },
    ],
  },
  {
    name: 'handoversignoffs',
    duplicates: { handoverSigner: { fields: ['handover', 'signer'] } },
    indexes: [
      { keys: { handover: 1, signer: 1 }, options: { unique: true, name: 'handover_1_signer_1' } },
      { keys: { project: 1, handover: 1, version: 1, createdAt: 1 }, options: { name: 'project_1_handover_1_version_1_createdAt_1' } },
      { keys: { expiresAt: 1 }, options: { expireAfterSeconds: 0, name: 'expiresAt_1' } },
    ],
  },
  {
    name: 'projectassignments',
    duplicates: { activeAssignment: { fields: ['project', 'user', 'role', 'scopeType', 'scopeValue'], filter: { status: 'active' } } },
    indexes: [
      { keys: { project: 1, user: 1, role: 1, scopeType: 1, scopeValue: 1, status: 1 }, options: { name: 'project_1_user_1_role_1_scopeType_1_scopeValue_1_status_1' } },
      { keys: { project: 1, user: 1, role: 1, scopeType: 1, scopeValue: 1 }, options: { unique: true, name: 'active_assignment_unique', partialFilterExpression: { status: 'active' } } },
    ],
  },
  {
    name: 'projectrepositories',
    duplicates: { activeRepository: { fields: ['project', 'repositoryId'], filter: { $or: [{ status: 'active' }, { status: { $exists: false } }] } } },
    indexes: [
      { keys: { project: 1, repositoryId: 1, status: 1 }, options: { unique: true, name: 'active_project_repository_unique', partialFilterExpression: { status: 'active' } } },
      { keys: { installation: 1, repositoryId: 1, status: 1 }, options: { name: 'installation_1_repositoryId_1_status_1' } },
      { keys: { project: 1, status: 1, createdAt: -1 }, options: { name: 'project_1_status_1_createdAt_-1' } },
    ],
  },
  {
    name: 'reviewhistories',
    indexes: [
      { keys: { finding: 1 }, options: { name: 'finding_1' } },
      { keys: { project: 1 }, options: { name: 'project_1' } },
      { keys: { finding: 1, createdAt: 1 }, options: { name: 'finding_1_createdAt_1' } },
    ],
  },
  {
    name: 'sources',
    duplicates: { githubIdentity: { fields: ['provider', 'repositoryLink', 'externalType', 'externalId'], filter: { provider: 'github', repositoryLink: { $exists: true }, externalId: { $exists: true } } } },
    indexes: [
      { keys: { provider: 1, repositoryLink: 1, externalType: 1, externalId: 1 }, options: { unique: true, name: 'provider_1_repositoryLink_1_externalType_1_externalId_1', partialFilterExpression: { provider: 'github', repositoryLink: { $exists: true }, externalId: { $exists: true } } } },
      { keys: { project: 1, provider: 1, status: 1 }, options: { name: 'project_1_provider_1_status_1' } },
    ],
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
    duplicates: { activeSync: { fields: ['repositoryLink', 'active'], filter: { active: true } } },
    indexes: [
      { keys: { repositoryLink: 1, active: 1 }, options: { unique: true, name: 'one_active_github_sync_per_repository_link', partialFilterExpression: { active: true } } },
      { keys: { project: 1, createdAt: -1 }, options: { name: 'project_1_createdAt_-1' } },
      { keys: { repositoryLink: 1, createdAt: -1 }, options: { name: 'repositoryLink_1_createdAt_-1' } },
    ],
  },
];

export async function runPhase5ProductionModelIndexMigration({ env = process.env, client = mongoose, dryRun = false, verifyOnly = false } = {}) {
  const target = validateMigrationTarget({
    uri: env.MONGODB_URI,
    expectedDatabase: env.PHASE5_MIGRATION_EXPECT_DATABASE,
    confirmation: env.PHASE5_MIGRATION_CONFIRM_TARGET,
    migrationId,
  });

  try {
    await client.connect(target.uri);
    const duplicateSummaries = {};
    const indexPlans = {};
    for (const definition of productionModelIndexDefinitions) {
      const collection = client.connection.db.collection(definition.name);
      for (const [label, duplicateDefinition] of Object.entries(definition.duplicates || {})) {
        duplicateSummaries[`${definition.name}.${label}`] = await countDuplicateKeys(collection, duplicateDefinition);
      }
      indexPlans[definition.name] = planIndexChanges(await readIndexes(collection), definition.indexes);
    }

    const indexesToCreate = Object.entries(indexPlans).flatMap(([collection, plan]) => plan.indexesToCreate.map((item) => ({ collection, ...item })));
    const indexesToChange = Object.entries(indexPlans).flatMap(([collection, plan]) => plan.indexesToChange.map((item) => ({ collection, ...item })));
    const report = { migrationId, targetDatabase: target.databaseName, dryRun, verifyOnly, duplicateSummaries, indexes: indexPlans, indexesToCreate, indexesToChange };
    const duplicateError = createDuplicatePreflightError(duplicateSummaries);
    if (duplicateError) { duplicateError.report = report; throw duplicateError; }
    if (indexesToChange.length) {
      const error = new Error('Conflicting production model indexes require manual review before migration.');
      error.code = 'MIGRATION_INDEX_CONFLICT';
      error.report = report;
      throw error;
    }
    if (verifyOnly) {
      if (indexesToCreate.length) {
        const error = new Error('Required model indexes are missing.');
        error.code = 'MIGRATION_INDEXES_MISSING';
        error.report = report;
        throw error;
      }
      return { ...report, verified: true };
    }
    if (dryRun) return report;

    for (const definition of productionModelIndexDefinitions) {
      const collection = client.connection.db.collection(definition.name);
      for (const item of indexPlans[definition.name].indexesToCreate) {
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
  const verifyOnly = process.argv.includes('--verify-only');
  try {
    const report = await runPhase5ProductionModelIndexMigration({ dryRun, verifyOnly });
    console.info(JSON.stringify(report));
  } catch (error) {
    if (error?.report) console.error(JSON.stringify(error.report));
    console.error(['MIGRATION_DUPLICATES', 'MIGRATION_INDEX_CONFLICT', 'MIGRATION_INDEXES_MISSING'].includes(error?.code)
      ? error.message
      : error?.message?.startsWith('MONGODB_URI') || error?.message?.startsWith('Expected migration') || error?.message?.startsWith('Migration confirmation')
        ? error.message
        : 'Phase 5 model-index migration failed; database connection details are suppressed.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
