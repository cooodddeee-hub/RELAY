import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { lookup } from 'node:dns/promises';
import { isIPv4, isIPv6 } from 'node:net';
import Handover from '../src/models/Handover.js';
import Project from '../src/models/Project.js';
import { acquireHandoverLock, allocateHandoverVersion } from '../src/services/handoverReport.js';
import { claimProjectRoleWrite } from '../src/services/projectLifecycle.js';

const testUri = process.env.RELAY_TEST_MONGODB_URI;
const localReplicaSetOnly = testUri ? { skip: false } : { skip: 'Set RELAY_TEST_MONGODB_URI to an isolated local MongoDB replica-set database.' };

async function assertSafeLocalTestUri(uri) {
  let parsed;
  try { parsed = new URL(uri); } catch { throw new Error('RELAY_TEST_MONGODB_URI must be a valid local mongodb:// URI.'); }
  if (parsed.protocol !== 'mongodb:' || !['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname)) {
    throw new Error('Integration tests refuse non-local MongoDB hosts; shared and production databases are not allowed.');
  }
  const addresses = await lookup(parsed.hostname.replace(/^\[|\]$/g, ''), { all: true });
  const allAddressesAreLoopback = addresses.length > 0 && addresses.every(({ address }) => (
    (isIPv4(address) && address.startsWith('127.')) || (isIPv6(address) && address === '::1')
  ));
  if (!allAddressesAreLoopback) throw new Error('Integration tests require the MongoDB host to resolve only to loopback addresses.');
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!/(?:^|[_-])test$/i.test(databaseName)) {
    throw new Error('Integration tests require a database name ending in "_test" or "-test".');
  }
}

function makeHandover(project, version) {
  return {
    project,
    version,
    reportContent: { version, sections: {} },
    findingIds: [],
    createdBy: new mongoose.Types.ObjectId(),
    approvalStatus: 'draft',
  };
}

test('MongoDB handover version integration (local replica set only)', localReplicaSetOnly, async (t) => {
  await assertSafeLocalTestUri(testUri);
  const ownedProjectIds = [];
  try {
    await mongoose.connect(testUri, { serverSelectionTimeoutMS: 2000 });
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    assert.ok(hello.setName, 'MongoDB must be a replica set to run this integration test.');
    assert.ok(hello.isWritablePrimary, 'The local replica set must have an elected primary.');

    await Promise.all([Project.init(), Handover.init()]);
    const session = await mongoose.startSession();
    const transactionProbeId = new mongoose.Types.ObjectId();
    try {
      session.startTransaction();
      await Project.collection.insertOne({
        _id: transactionProbeId,
        name: 'round3-transaction-probe',
        owner: new mongoose.Types.ObjectId(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }, { session });
      await session.abortTransaction();
      assert.equal(await Project.collection.countDocuments({ _id: transactionProbeId }), 0);
    } finally {
      await session.endSession();
    }
    const indexes = await Handover.collection.indexes();
    assert.ok(indexes.some((index) => index.unique
      && index.key.project === 1 && index.key.version === 1), 'unique project/version index must exist');

    const newProject = async (name) => {
      const project = await Project.create({ name, owner: new mongoose.Types.ObjectId() });
      ownedProjectIds.push(project._id);
      return project;
    };

    await t.test('concurrent allocations persist distinct versions protected by the compound index', async () => {
      const project = await newProject(`round3-concurrency-${new mongoose.Types.ObjectId()}`);
      const versions = await Promise.all(Array.from({ length: 20 }, () => (
        allocateHandoverVersion(Project, Handover, project._id)
      )));
      assert.equal(new Set(versions).size, 20);
      assert.deepEqual([...versions].sort((a, b) => a - b), Array.from({ length: 20 }, (_, index) => index + 1));
      const saved = await Promise.all(versions.map((version) => Handover.create(makeHandover(project._id, version))));
      assert.equal(saved.length, 20);
      await assert.rejects(Handover.create(makeHandover(project._id, versions[0])), (error) => error.code === 11000);
      assert.equal(await Handover.countDocuments({ project: project._id }), 20);
    });

    await t.test('legacy project allocation starts above its highest saved handover', async () => {
      const project = await newProject(`round3-legacy-${new mongoose.Types.ObjectId()}`);
      await Handover.create([makeHandover(project._id, 2), makeHandover(project._id, 8)]);
      assert.equal(project.handoverVersionCounter, undefined);
      assert.equal(await allocateHandoverVersion(Project, Handover, project._id), 9);
    });

    await t.test('a failed handover save does not reuse its reserved version', async () => {
      const project = await newProject(`round3-save-failure-${new mongoose.Types.ObjectId()}`);
      const reserved = await allocateHandoverVersion(Project, Handover, project._id);
      // Model a competing writer taking the reserved key; the unique index must
      // reject this save, and the monotonic allocator must not reuse the key.
      await Handover.create(makeHandover(project._id, reserved));
      await assert.rejects(Handover.create(makeHandover(project._id, reserved)), (error) => error.code === 11000);
      assert.equal(await allocateHandoverVersion(Project, Handover, project._id), reserved + 1);
      assert.equal(await Handover.countDocuments({ project: project._id, version: reserved }), 1);
    });

    await t.test('real concurrent lock transactions retry and cannot replace the first valid lock', async () => {
      const ownerId = new mongoose.Types.ObjectId();
      const project = await Project.create({
        name: `round3-lock-conflict-${new mongoose.Types.ObjectId()}`,
        owner: ownerId,
        members: [{ user: ownerId, role: 'owner' }],
      });
      ownedProjectIds.push(project._id);
      let announceLock;
      let releaseLock;
      const lockClaimed = new Promise((resolve) => { announceLock = resolve; });
      const holdFirstTransaction = new Promise((resolve) => { releaseLock = resolve; });
      const firstSession = await mongoose.startSession();
      const secondSession = await mongoose.startSession();
      let secondAttempts = 0;
      try {
        const first = firstSession.withTransaction(async () => {
          await claimProjectRoleWrite(project._id, ownerId, 'editor', firstSession);
          assert.equal(await acquireHandoverLock(Project, project._id, ownerId, 'first-lock', new Date(), 120_000, { session: firstSession }), true);
          announceLock();
          await holdFirstTransaction;
        });
        await lockClaimed;
        const second = secondSession.withTransaction(async () => {
          secondAttempts += 1;
          await claimProjectRoleWrite(project._id, ownerId, 'editor', secondSession);
          const acquired = await acquireHandoverLock(Project, project._id, ownerId, 'second-lock', new Date(), 120_000, { session: secondSession });
          if (!acquired) {
            const error = new Error('Concurrent handover lock is held.');
            error.status = 409;
            throw error;
          }
        });
        await new Promise((resolve) => setTimeout(resolve, 75));
        releaseLock();
        await first;
        await assert.rejects(second, /Concurrent handover lock is held/);
        assert.ok(secondAttempts >= 2, 'the real transaction callback should retry after project-document write contention');
        const saved = await Project.findById(project._id).select('+handoverLockToken').lean();
        assert.equal(saved.handoverLockToken, 'first-lock');
      } finally {
        releaseLock();
        await Promise.all([firstSession.endSession(), secondSession.endSession()]);
      }
    });
  } finally {
    if (mongoose.connection.readyState === 1) {
      if (ownedProjectIds.length) {
        await Handover.deleteMany({ project: { $in: ownedProjectIds } });
        await Project.deleteMany({ _id: { $in: ownedProjectIds } });
      }
      await mongoose.disconnect();
    }
  }
});
