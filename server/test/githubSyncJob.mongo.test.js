import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import GitHubSyncJob from '../src/models/GitHubSyncJob.js';
import Source from '../src/models/Source.js';
import SourceRevision from '../src/models/SourceRevision.js';
import { runPhase4GitHubSyncIndexMigration } from '../scripts/migrations/phase4-github-sync-indexes.js';

const testUri = process.env.RELAY_TEST_MONGODB_URI;
const replicaSetOnly = testUri ? { skip: false } : { skip: 'Set RELAY_TEST_MONGODB_URI to the isolated local replica-set database.' };

async function assertIsolatedReplicaSet(uri) {
  let parsed;
  try { parsed = new URL(uri); } catch { throw new Error('RELAY_TEST_MONGODB_URI must be a valid local MongoDB URI.'); }
  if (parsed.protocol !== 'mongodb:' || parsed.hostname !== '127.0.0.1' || parsed.port !== '27018'
    || decodeURIComponent(parsed.pathname.replace(/^\//, '')) !== 'relay_round3_test') {
    throw new Error('GitHub sync job integration tests only permit 127.0.0.1:27018/relay_round3_test.');
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 3000 });
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  assert.equal(hello.setName, 'rs0', 'The isolated local MongoDB replica set rs0 is required.');
  assert.equal(hello.isWritablePrimary, true, 'The isolated MongoDB replica set must have an elected primary.');
}

test('GitHub sync-job locking integration (isolated replica set only)', replicaSetOnly, async (t) => {
  const repositoryLinkIds = [];
  const sourceIds = [];
  const revisionIds = [];
  try {
    await assertIsolatedReplicaSet(testUri);
    const migrationEnv = {
      MONGODB_URI: testUri,
      PHASE4_MIGRATION_EXPECT_DATABASE: 'relay_round3_test',
      PHASE4_MIGRATION_CONFIRM_TARGET: 'APPLY_PHASE4_GITHUB_SYNC_INDEXES:relay_round3_test',
    };
    const firstMigration = await runPhase4GitHubSyncIndexMigration({ env: migrationEnv });
    const secondMigration = await runPhase4GitHubSyncIndexMigration({ env: migrationEnv });
    assert.equal(firstMigration.targetDatabase, 'relay_round3_test');
    assert.equal(firstMigration.applied, true);
    assert.equal(secondMigration.applied, true);
    assert.equal(Object.values(secondMigration.indexes).flatMap((plan) => plan.indexesToCreate).length, 0);
    await mongoose.connect(testUri, { serverSelectionTimeoutMS: 3000 });
    await Promise.all([GitHubSyncJob.init(), Source.init(), SourceRevision.init()]);
    const indexes = await GitHubSyncJob.collection.indexes();
    assert.ok(indexes.some((index) => index.name === 'one_active_github_sync_per_repository_link'
      && index.unique && index.partialFilterExpression?.active === true));

    await t.test('migration-created source and revision unique indexes reject duplicates', async () => {
      const repositoryLink = new mongoose.Types.ObjectId();
      const sourceId = new mongoose.Types.ObjectId();
      const projectId = new mongoose.Types.ObjectId();
      sourceIds.push(sourceId);
      const sourceRecord = {
        _id: sourceId, project: projectId, provider: 'github', repositoryLink,
        externalType: 'issue', externalId: 'round3-phase4a-issue', originalName: 'Issue #phase4a',
      };
      await Source.collection.insertOne(sourceRecord);
      await assert.rejects(Source.collection.insertOne({ ...sourceRecord, _id: new mongoose.Types.ObjectId() }), (error) => error.code === 11000);

      const revisionId = new mongoose.Types.ObjectId();
      revisionIds.push(revisionId);
      const revisionRecord = {
        _id: revisionId, source: sourceId, revisionKey: 'round3-phase4a-revision', contentHash: 'fixture',
        textSnapshot: 'fixture', capturedAt: new Date(),
      };
      await SourceRevision.collection.insertOne(revisionRecord);
      await assert.rejects(SourceRevision.collection.insertOne({ ...revisionRecord, _id: new mongoose.Types.ObjectId() }), (error) => error.code === 11000);
    });

    const makeFields = (repositoryLink) => ({
      project: new mongoose.Types.ObjectId(),
      repositoryLink,
      installation: new mongoose.Types.ObjectId(),
      requestedBy: new mongoose.Types.ObjectId(),
    });

    await t.test('concurrent first claims return one active job and one created result', async () => {
      const repositoryLink = new mongoose.Types.ObjectId();
      repositoryLinkIds.push(repositoryLink);
      const results = await Promise.all(Array.from({ length: 20 }, () => (
        GitHubSyncJob.createOrGetActive(makeFields(repositoryLink))
      )));
      assert.equal(results.filter((result) => result.created).length, 1);
      assert.equal(new Set(results.map((result) => String(result.job._id))).size, 1);
      assert.equal(await GitHubSyncJob.countDocuments({ repositoryLink, active: true }), 1);

      await assert.rejects(GitHubSyncJob.create({ ...makeFields(repositoryLink), active: true }), (error) => error.code === 11000);
    });

    await t.test('terminal jobs release the unique active slot for a later manual sync', async () => {
      const repositoryLink = new mongoose.Types.ObjectId();
      repositoryLinkIds.push(repositoryLink);
      const first = await GitHubSyncJob.createOrGetActive(makeFields(repositoryLink));
      first.job.status = 'completed';
      first.job.active = false;
      first.job.completedAt = new Date();
      await first.job.save();

      const second = await GitHubSyncJob.createOrGetActive(makeFields(repositoryLink));
      assert.equal(second.created, true);
      assert.notEqual(String(second.job._id), String(first.job._id));
      assert.equal(await GitHubSyncJob.countDocuments({ repositoryLink, active: true }), 1);
    });

    await t.test('partial and retry-wait jobs keep the repository locked', async () => {
      for (const status of ['partial', 'retry_wait']) {
        const repositoryLink = new mongoose.Types.ObjectId();
        repositoryLinkIds.push(repositoryLink);
        const fields = { ...makeFields(repositoryLink), status, active: true };
        const first = await GitHubSyncJob.createOrGetActive(fields);
        assert.equal(first.created, true);
        const second = await GitHubSyncJob.createOrGetActive(makeFields(repositoryLink));
        assert.equal(second.created, false);
        assert.equal(String(second.job._id), String(first.job._id));
      }
    });
  } finally {
    if (mongoose.connection.readyState === 1) {
      if (repositoryLinkIds.length) await GitHubSyncJob.deleteMany({ repositoryLink: { $in: repositoryLinkIds } });
      if (revisionIds.length) await SourceRevision.deleteMany({ _id: { $in: revisionIds } });
      if (sourceIds.length) await Source.deleteMany({ _id: { $in: sourceIds } });
      await mongoose.disconnect();
    }
  }
});
