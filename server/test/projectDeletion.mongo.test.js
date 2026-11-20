import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { lookup } from 'node:dns/promises';
import { isIPv4, isIPv6 } from 'node:net';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import User from '../src/models/User.js';
import Project from '../src/models/Project.js';
import ProjectAssignment from '../src/models/ProjectAssignment.js';
import ProjectDeletionJob from '../src/models/ProjectDeletionJob.js';
import ProjectRepository from '../src/models/ProjectRepository.js';
import GitHubInstallation from '../src/models/GitHubInstallation.js';
import Source from '../src/models/Source.js';
import SourceRevision from '../src/models/SourceRevision.js';
import Finding from '../src/models/Finding.js';
import ReviewHistory from '../src/models/ReviewHistory.js';
import ContradictionCandidate from '../src/models/ContradictionCandidate.js';
import Handover from '../src/models/Handover.js';
import HandoverSignoff from '../src/models/HandoverSignoff.js';
import AuditEvent from '../src/models/AuditEvent.js';
import AnalysisJob from '../src/models/AnalysisJob.js';
import GitHubSyncJob from '../src/models/GitHubSyncJob.js';
import { cancelProjectDeletion, processProjectDeletionBatch, requestProjectDeletion, PROJECT_DELETION_RECOVERY_MS } from '../src/services/projectDeletion.js';

const testUri = process.env.RELAY_TEST_MONGODB_URI;
const testOptions = testUri ? { skip: false } : { skip: 'Set RELAY_TEST_MONGODB_URI to an isolated local replica-set database.' };

async function assertSafeTestUri(uri) {
  let parsed;
  try { parsed = new URL(uri); } catch { throw new Error('RELAY_TEST_MONGODB_URI must be a valid local mongodb:// URI.'); }
  if (parsed.protocol !== 'mongodb:' || !['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname)) throw new Error('Project deletion tests require loopback MongoDB.');
  const addresses = await lookup(parsed.hostname.replace(/^\[|\]$/g, ''), { all: true });
  if (!addresses.length || !addresses.every(({ address }) => (isIPv4(address) && address.startsWith('127.')) || (isIPv6(address) && address === '::1'))) throw new Error('Project deletion tests require loopback-only MongoDB.');
  if (decodeURIComponent(parsed.pathname.replace(/^\//, '')) !== 'relay_round3_test') throw new Error('Project deletion tests require relay_round3_test.');
}

test('project deletion freezes access, supports recovery, and retryably purges project content while retaining audit/signoff metadata (local replica set only)', testOptions, async (t) => {
  await assertSafeTestUri(testUri);
  const envKeys = ['MONGODB_URI', 'JWT_SECRET', 'AUDIT_RETENTION_DAYS', 'SIGNOFF_RETENTION_DAYS', 'CRON_SECRET'];
  const priorEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const ids = { users: [], projects: [], sources: [], revisions: [], findings: [], candidates: [], handovers: [], signoffs: [], installations: [], assignments: [] };
  let server;
  try {
    process.env.MONGODB_URI = testUri;
    process.env.JWT_SECRET = 'relay-deletion-local-test-key-for-integration';
    // The test advances the simulated cleanup clock beyond the 30-day recovery
    // window; keep audit events unexpired against the real MongoDB clock.
    process.env.AUDIT_RETENTION_DAYS = '36500';
    process.env.SIGNOFF_RETENTION_DAYS = '365';
    process.env.CRON_SECRET = 'local-test-scheduler-secret';
    const [{ default: app }] = await Promise.all([import('../src/app.js')]);
    await mongoose.connect(testUri, { serverSelectionTimeoutMS: 2000 });
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    assert.ok(hello.setName && hello.isWritablePrimary, 'tests require an isolated transaction-capable replica set');
    const models = [User, Project, ProjectAssignment, ProjectDeletionJob, ProjectRepository, GitHubInstallation, Source, SourceRevision, Finding, ReviewHistory, ContradictionCandidate, Handover, HandoverSignoff, AuditEvent, AnalysisJob, GitHubSyncJob];
    await Promise.all(models.map((model) => model.init()));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const owner = await User.create({ name: 'Deletion owner', email: `deletion-${new mongoose.Types.ObjectId()}@example.test`, passwordHash: 'integration-only' });
    const member = await User.create({ name: 'Deletion member', email: `deletion-member-${new mongoose.Types.ObjectId()}@example.test`, passwordHash: 'integration-only' });
    ids.users.push(owner._id, member._id);
    const ownerToken = jwt.sign({ sub: String(owner._id) }, process.env.JWT_SECRET, { expiresIn: '10m' });
    const memberToken = jwt.sign({ sub: String(member._id) }, process.env.JWT_SECRET, { expiresIn: '10m' });
    const request = async (token, path, options = {}) => {
      const response = await fetch(`${baseUrl}${path}`, { ...options, headers: { authorization: `Bearer ${token}`, ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers } });
      return { status: response.status, data: await response.json() };
    };
    const project = await Project.create({
      name: `Deletion fixture ${new mongoose.Types.ObjectId()}`, owner: owner._id,
      members: [{ user: owner._id, role: 'owner' }, { user: member._id, role: 'viewer' }],
    });
    ids.projects.push(project._id);
    const installation = await GitHubInstallation.create({ installationId: `installation-${new mongoose.Types.ObjectId()}`, accountId: '99', accountLogin: 'shared-org', accountType: 'Organization', installedBy: owner._id, authorizedUsers: [owner._id] });
    ids.installations.push(installation._id);
    const repository = await ProjectRepository.create({ project: project._id, installation: installation._id, repositoryId: '123', ownerLogin: 'shared-org', name: 'demo', fullName: 'shared-org/demo', htmlUrl: 'https://github.com/shared-org/demo', linkedBy: owner._id });
    const source = await Source.create({ project: project._id, provider: 'upload', originalName: 'Uploaded note.txt', mimeType: 'text/plain', size: 22, extractedText: 'A captured claim exists.', status: 'processed', storagePath: '/outside-relay-managed-root/must-not-delete.txt', uploadedBy: owner._id });
    ids.sources.push(source._id);
    const revision = await SourceRevision.create({ source: source._id, revisionKey: 'issue-77-r1', contentHash: 'safe-hash', textSnapshot: 'A captured claim exists.' });
    ids.revisions.push(revision._id);
    const finding = await Finding.create({ project: project._id, category: 'Decision', title: 'Example claim', description: 'A captured claim exists.', status: 'approved', evidence: [{ source: source._id, sourceRevision: revision._id, sourceName: 'Issue #77', quote: 'A captured claim exists.', matchedText: 'A captured claim exists.', verificationStatus: 'verified' }] });
    ids.findings.push(finding._id);
    await ReviewHistory.create({ finding: finding._id, project: project._id, reviewer: owner._id, action: 'approved' });
    const candidate = await ContradictionCandidate.create({
      project: project._id, candidateKey: 'retained-test-candidate', claims: [{ summary: 'One claim' }, { summary: 'Another claim' }],
      evidence: [{ source: source._id, sourceRevision: revision._id, quote: 'A captured claim exists.' }, { source: source._id, sourceRevision: new mongoose.Types.ObjectId(), quote: 'A different captured claim exists.' }],
      relationship: 'possible_conflict', cautiousLabel: 'needs_human_check', confidenceBand: 'low', explanation: 'Test candidate.',
    });
    ids.candidates.push(candidate._id);
    const assignment = await ProjectAssignment.create({ project: project._id, user: member._id, role: 'approver', scopeType: 'project', assignedBy: owner._id });
    ids.assignments.push(assignment._id);
    const handover = await Handover.create({ project: project._id, version: 1, reportContent: { project: { name: 'Fixture' } }, createdBy: owner._id, approvalStatus: 'approved' });
    ids.handovers.push(handover._id);
    const signoff = await HandoverSignoff.create({ project: project._id, handover: handover._id, version: 1, signer: member._id, assignment: assignment._id, decision: 'approved', comment: 'Approved exact version.', expiresAt: new Date(Date.now() + 365 * 86400000) });
    ids.signoffs.push(signoff._id);
    await AnalysisJob.create({ project: project._id, createdBy: owner._id, sourceIds: [source._id] });
    await GitHubSyncJob.create({ project: project._id, repositoryLink: repository._id, installation: installation._id, requestedBy: owner._id, status: 'completed', active: false, stage: 'finalize' });

    await t.test('owner deletion tombstone freezes member access and can be cancelled inside recovery', async () => {
      const response = await request(ownerToken, `/projects/${project._id}`, { method: 'DELETE' });
      assert.equal(response.status, 202);
      assert.equal(response.data.deletion.state, 'queued');
      assert.equal((await request(memberToken, `/projects/${project._id}`)).status, 410);
      assert.equal((await request(memberToken, '/projects')).data.projects.some((item) => String(item._id) === String(project._id)), false);
      const status = await request(ownerToken, `/projects/${project._id}/deletion`);
      assert.equal(status.status, 200);
      assert.equal(status.data.deletion.job.status, 'queued');
      const scheduler = await request(ownerToken, '/internal/project-deletions/process', { headers: { authorization: 'Bearer local-test-scheduler-secret' } });
      assert.equal(scheduler.status, 200);
      assert.equal(scheduler.data.processedProjects, 0, 'the recovery window prevents premature cleanup');
      const recovered = await cancelProjectDeletion({ projectId: project._id, actorId: owner._id, now: new Date(Date.now() + 5 * 86400000) });
      assert.equal(recovered.deletionState, 'active');
      assert.equal((await ProjectDeletionJob.findOne({ projectId: project._id })).phase, 'cancelled');
      const repeated = await request(ownerToken, `/projects/${project._id}`, { method: 'DELETE' });
      assert.equal(repeated.status, 202, 'a later deletion request reuses the cancelled job safely');
    });

    await t.test('processor rejects unauthorized calls and uses a bounded local batch', async () => {
      const unauthorized = await request(ownerToken, '/internal/project-deletions/process');
      assert.equal(unauthorized.status, 401);
      const scheduler = await request(ownerToken, '/internal/project-deletions/process', { headers: { authorization: 'Bearer local-test-scheduler-secret' } });
      assert.equal(scheduler.status, 200);
      assert.equal(scheduler.data.processedProjects, 0, 'the recovery window prevents premature cleanup');
      const due = await processProjectDeletionBatch({ now: new Date(Date.now() + PROJECT_DELETION_RECOVERY_MS + 1), batchSize: 1 });
      assert.ok(due.processedProjects <= 1);
      const firstJob = await ProjectDeletionJob.findOne({ projectId: project._id });
      assert.equal(firstJob.status, 'retry_wait', 'unsafe local path is retained and scheduled for retry');
      assert.equal(firstJob.lastErrorCode, 'UNSAFE_STORAGE_PATH');
      await Source.updateOne({ _id: source._id }, { $unset: { storagePath: 1 } });
    });

    await t.test('safe retry purges content in resumable batches, retains metadata, and keeps shared GitHub installation', async () => {
      let now = new Date(Date.now() + PROJECT_DELETION_RECOVERY_MS + 40_000);
      let result;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        result = await processProjectDeletionBatch({ now, batchSize: 1 });
        const state = await ProjectDeletionJob.findOne({ projectId: project._id }).lean();
        const projectState = await Project.findById(project._id).select('deletionState').lean();
        if (projectState?.deletionState === 'complete') break;
        now = new Date(now.getTime() + 7 * 60 * 60 * 1000);
      }
      const deletionJob = await ProjectDeletionJob.findOne({ projectId: project._id }).lean();
      assert.equal(deletionJob, null, 'retry metadata is removed after successful purge');
      assert.equal((await Project.findById(project._id)).deletionState, 'complete');
      assert.equal(await Source.countDocuments({ project: project._id }), 0);
      assert.equal(await SourceRevision.countDocuments({ source: { $in: ids.sources } }), 0);
      assert.equal(await Finding.countDocuments({ project: project._id }), 0);
      assert.equal(await ReviewHistory.countDocuments({ project: project._id }), 0);
      assert.equal(await ContradictionCandidate.countDocuments({ project: project._id }), 0);
      assert.equal(await ProjectAssignment.countDocuments({ project: project._id }), 0);
      assert.equal(await Handover.countDocuments({ project: project._id }), 0);
      assert.equal(await ProjectRepository.countDocuments({ project: project._id }), 0);
      assert.equal(await AnalysisJob.countDocuments({ project: project._id }), 0);
      assert.equal(await GitHubSyncJob.countDocuments({ project: project._id }), 0);
      assert.equal(await HandoverSignoff.countDocuments({ _id: { $in: ids.signoffs } }), 1);
      assert.equal(await GitHubInstallation.countDocuments({ _id: installation._id }), 1, 'shared installations are preserved');
      assert.ok(await AuditEvent.countDocuments({ projectId: project._id }) >= 3);
    });
  } finally {
    if (server) { server.close(); await once(server, 'close'); }
    if (mongoose.connection.readyState) {
      await Promise.all([
        AuditEvent.deleteMany({ projectId: { $in: ids.projects } }), HandoverSignoff.deleteMany({ _id: { $in: ids.signoffs } }),
        Handover.deleteMany({ _id: { $in: ids.handovers } }), ContradictionCandidate.deleteMany({ _id: { $in: ids.candidates } }),
        Finding.deleteMany({ _id: { $in: ids.findings } }), ReviewHistory.deleteMany({ project: { $in: ids.projects } }),
        SourceRevision.deleteMany({ _id: { $in: ids.revisions } }), Source.deleteMany({ _id: { $in: ids.sources } }),
        ProjectRepository.deleteMany({ project: { $in: ids.projects } }), ProjectAssignment.deleteMany({ _id: { $in: ids.assignments } }),
        ProjectDeletionJob.deleteMany({ projectId: { $in: ids.projects } }), AnalysisJob.deleteMany({ project: { $in: ids.projects } }),
        GitHubSyncJob.deleteMany({ project: { $in: ids.projects } }), Project.deleteMany({ _id: { $in: ids.projects } }),
        GitHubInstallation.deleteMany({ _id: { $in: ids.installations } }), User.deleteMany({ _id: { $in: ids.users } }),
      ]);
      await mongoose.disconnect();
    }
    for (const key of envKeys) {
      if (priorEnv[key] === undefined) delete process.env[key];
      else process.env[key] = priorEnv[key];
    }
  }
});
