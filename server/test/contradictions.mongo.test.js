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
import Source from '../src/models/Source.js';
import SourceRevision from '../src/models/SourceRevision.js';
import Finding from '../src/models/Finding.js';
import ContradictionCandidate from '../src/models/ContradictionCandidate.js';
import AuditEvent from '../src/models/AuditEvent.js';
import Handover from '../src/models/Handover.js';

const testUri = process.env.RELAY_TEST_MONGODB_URI;
const testOptions = testUri ? { skip: false } : { skip: 'Set RELAY_TEST_MONGODB_URI to an isolated local replica-set database.' };

async function assertSafeTestUri(uri) {
  let parsed;
  try { parsed = new URL(uri); } catch { throw new Error('RELAY_TEST_MONGODB_URI must be a valid local mongodb:// URI.'); }
  if (parsed.protocol !== 'mongodb:' || !['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname)) throw new Error('Contradiction integration tests require a loopback MongoDB host.');
  const addresses = await lookup(parsed.hostname.replace(/^\[|\]$/g, ''), { all: true });
  if (!addresses.length || !addresses.every(({ address }) => (isIPv4(address) && address.startsWith('127.')) || (isIPv6(address) && address === '::1'))) throw new Error('Contradiction integration tests require loopback-only MongoDB.');
  if (decodeURIComponent(parsed.pathname.replace(/^\//, '')) !== 'relay_round3_test') throw new Error('Contradiction integration tests require relay_round3_test.');
}

test('contradiction detection, reviewer decisions, audit history, and handover inclusion (local replica set only)', testOptions, async (t) => {
  await assertSafeTestUri(testUri);
  const envKeys = ['MONGODB_URI', 'JWT_SECRET', 'AUDIT_RETENTION_DAYS'];
  const priorEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const userIds = [];
  const projectIds = [];
  const sourceIds = [];
  const revisionIds = [];
  const findingIds = [];
  const candidateIds = [];
  const handoverIds = [];
  let server;
  try {
    process.env.MONGODB_URI = testUri;
    process.env.JWT_SECRET = 'relay-contradictions-local-test-key-for-integration';
    process.env.AUDIT_RETENTION_DAYS = '365';
    const [{ default: app }] = await Promise.all([import('../src/app.js')]);
    await mongoose.connect(testUri, { serverSelectionTimeoutMS: 2000 });
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    assert.ok(hello.setName && hello.isWritablePrimary, 'tests require an isolated transaction-capable replica set');
    await Promise.all([User.init(), Project.init(), ProjectAssignment.init(), Source.init(), SourceRevision.init(), Finding.init(), ContradictionCandidate.init(), AuditEvent.init(), Handover.init()]);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const users = {};
    for (const role of ['owner', 'editor', 'reviewer', 'viewer', 'outsider']) {
      const user = await User.create({ name: `Contradiction ${role}`, email: `contradiction-${role}-${new mongoose.Types.ObjectId()}@example.test`, passwordHash: 'integration-only' });
      users[role] = user;
      userIds.push(user._id);
    }
    const tokens = Object.fromEntries(Object.entries(users).map(([role, user]) => [role, jwt.sign({ sub: String(user._id) }, process.env.JWT_SECRET, { expiresIn: '10m' })]));
    const api = async (role, path, options = {}) => {
      const response = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers: { authorization: `Bearer ${tokens[role]}`, ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers },
      });
      return { status: response.status, data: await response.json() };
    };
    const project = await Project.create({
      name: `Contradiction fixture ${new mongoose.Types.ObjectId()}`,
      owner: users.owner._id,
      workflowPolicy: { reviewMode: 'assigned', signoffMode: 'none' },
      members: [
        { user: users.owner._id, role: 'owner' }, { user: users.editor._id, role: 'editor' },
        { user: users.reviewer._id, role: 'viewer' }, { user: users.viewer._id, role: 'viewer' },
      ],
    });
    projectIds.push(project._id);
    const makeSource = async (number, text) => {
      const source = await Source.create({ project: project._id, provider: 'github', externalType: 'issue', externalId: `issue-${number}`, originalName: `Issue #${number}`, mimeType: 'text/plain', size: text.length, extractedText: text, status: 'processed', uploadedBy: users.owner._id });
      sourceIds.push(source._id);
      const revision = await SourceRevision.create({ source: source._id, revisionKey: `issue-${number}-revision-1`, contentHash: `hash-${number}`, textSnapshot: text, capturedAt: new Date() });
      revisionIds.push(revision._id);
      await Source.updateOne({ _id: source._id }, { $set: { currentRevision: revision._id } });
      return { source, revision };
    };
    const evidenceA = 'The release is scheduled for June 5.';
    const evidenceB = 'The release is scheduled for July 6.';
    const [first, second] = await Promise.all([makeSource(101, evidenceA), makeSource(102, evidenceB)]);
    for (const [index, [item, text]] of [[first, evidenceA], [second, evidenceB]].entries()) {
      const finding = await Finding.create({
        project: project._id, category: 'Decision', title: 'Launch date',
        description: text, status: 'approved',
        evidence: [{ source: item.source._id, sourceRevision: item.revision._id, sourceName: item.source.originalName, quote: text, matchedText: text, startOffset: 0, endOffset: text.length, verificationStatus: 'verified' }],
      });
      findingIds.push(finding._id);
      assert.equal(index < 2, true);
    }
    await ProjectAssignment.create({ project: project._id, user: users.reviewer._id, role: 'reviewer', scopeType: 'category', scopeValue: 'Decision', assignedBy: users.owner._id });

    await t.test('editor can create cautious candidate once; viewer and non-member cannot detect', async () => {
      const deniedViewer = await api('viewer', `/projects/${project._id}/contradictions/detect`, { method: 'POST', body: '{}' });
      const deniedOutsider = await api('outsider', `/projects/${project._id}/contradictions/detect`, { method: 'POST', body: '{}' });
      assert.equal(deniedViewer.status, 403);
      assert.equal(deniedOutsider.status, 403);
      const result = await api('editor', `/projects/${project._id}/contradictions/detect`, { method: 'POST', body: '{}' });
      assert.equal(result.status, 200);
      assert.equal(result.data.createdCount, 1);
      assert.equal(result.data.candidates[0].status, 'candidate');
      assert.equal(result.data.candidates[0].cautiousLabel, 'needs_human_check');
      assert.equal(result.data.candidates[0].evidence.length, 2);
      assert.notEqual(String(result.data.candidates[0].evidence[0].sourceRevision), String(result.data.candidates[0].evidence[1].sourceRevision));
      candidateIds.push(new mongoose.Types.ObjectId(result.data.candidates[0]._id));
      const repeated = await api('editor', `/projects/${project._id}/contradictions/detect`, { method: 'POST', body: '{}' });
      assert.equal(repeated.status, 200);
      assert.equal(repeated.data.createdCount, 0);
      assert.equal(await AuditEvent.countDocuments({ projectId: project._id, action: 'contradiction.candidate_detected' }), 1);
      const listed = await api('viewer', `/projects/${project._id}/contradictions`);
      assert.equal(listed.status, 200);
      assert.equal(listed.data.candidates[0].claims[0].finding.title, 'Launch date');
      assert.match(listed.data.candidates[0].evidence[0].source.originalName, /^Issue #/);
      assert.match(listed.data.candidates[0].evidence[0].sourceRevision.revisionKey, /revision-1/);
    });

    await t.test('only an authorized reviewer can decide, rationale is required, and prior history is append-only', async () => {
      const candidateId = candidateIds[0];
      const noRationale = await api('reviewer', `/projects/${project._id}/contradictions/${candidateId}/review`, { method: 'POST', body: JSON.stringify({ status: 'confirmed_conflict' }) });
      assert.equal(noRationale.status, 400);
      const unauthorized = await api('viewer', `/projects/${project._id}/contradictions/${candidateId}/review`, { method: 'POST', body: JSON.stringify({ status: 'confirmed_conflict', reason: 'Should be denied.' }) });
      assert.equal(unauthorized.status, 403);
      const started = await api('reviewer', `/projects/${project._id}/contradictions/${candidateId}/review`, { method: 'POST', body: JSON.stringify({ status: 'in_review', reason: 'Checking both source snapshots.' }) });
      assert.equal(started.status, 200);
      const confirmed = await api('reviewer', `/projects/${project._id}/contradictions/${candidateId}/review`, { method: 'POST', body: JSON.stringify({ status: 'confirmed_conflict', reason: 'Both exact quotations support incompatible dates.' }) });
      assert.equal(confirmed.status, 200);
      assert.equal(confirmed.data.candidate.status, 'confirmed_conflict');
      const historyDenied = await api('reviewer', `/projects/${project._id}/contradictions/${candidateId}/history`);
      assert.equal(historyDenied.status, 403);
      const history = await api('owner', `/projects/${project._id}/contradictions/${candidateId}/history`);
      assert.equal(history.status, 200);
      assert.deepEqual(history.data.events.map((event) => event.action), ['contradiction.candidate_detected', 'contradiction.in_review', 'contradiction.confirmed_conflict']);
      assert.equal(history.data.events.at(-1).reason, 'Both exact quotations support incompatible dates.');
      assert.equal(history.data.events.at(-1).actorId.name, 'Contradiction reviewer');
      const terminal = await api('reviewer', `/projects/${project._id}/contradictions/${candidateId}/review`, { method: 'POST', body: JSON.stringify({ status: 'dismissed', reason: 'This must conflict with the terminal transition.' }) });
      assert.equal(terminal.status, 409);
    });

    await t.test('only confirmed candidates enter new immutable handover snapshots', async () => {
      const response = await api('owner', `/projects/${project._id}/handover`, { method: 'POST', body: '{}' });
      assert.equal(response.status, 201);
      handoverIds.push(new mongoose.Types.ObjectId(response.data.handover._id));
      const conflicts = response.data.handover.reportContent.sections['Confirmed Conflicts'];
      assert.equal(conflicts.length, 1);
      assert.equal(conflicts[0].status, 'confirmed_conflict');
      assert.equal(conflicts[0].reviewerRationale, 'Both exact quotations support incompatible dates.');
      assert.equal(conflicts[0].evidence.length, 2);
      assert.ok(conflicts[0].evidence.every((item) => item.sourceRevisionId && item.verificationStatus === 'verified'));
    });
  } finally {
    if (server) { server.close(); await once(server, 'close'); }
    if (mongoose.connection.readyState) {
      await Promise.all([
        AuditEvent.deleteMany({ projectId: { $in: projectIds } }), Handover.deleteMany({ _id: { $in: handoverIds } }),
        ContradictionCandidate.deleteMany({ _id: { $in: candidateIds } }), Finding.deleteMany({ _id: { $in: findingIds } }),
        SourceRevision.deleteMany({ _id: { $in: revisionIds } }), Source.deleteMany({ _id: { $in: sourceIds } }),
        ProjectAssignment.deleteMany({ project: { $in: projectIds } }), Project.deleteMany({ _id: { $in: projectIds } }),
        User.deleteMany({ _id: { $in: userIds } }),
      ]);
      await mongoose.disconnect();
    }
    for (const key of envKeys) {
      if (priorEnv[key] === undefined) delete process.env[key];
      else process.env[key] = priorEnv[key];
    }
  }
});
