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
import Handover from '../src/models/Handover.js';
import HandoverSignoff from '../src/models/HandoverSignoff.js';
import AuditEvent from '../src/models/AuditEvent.js';

const testUri = process.env.RELAY_TEST_MONGODB_URI;
const testOptions = testUri ? { skip: false } : { skip: 'Set RELAY_TEST_MONGODB_URI to an isolated local replica-set database.' };

async function assertSafeTestUri(uri) {
  let parsed;
  try { parsed = new URL(uri); } catch { throw new Error('RELAY_TEST_MONGODB_URI must be a valid local mongodb:// URI.'); }
  if (parsed.protocol !== 'mongodb:' || !['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname)) throw new Error('Handover sign-off tests require a loopback MongoDB host.');
  const addresses = await lookup(parsed.hostname.replace(/^\[|\]$/g, ''), { all: true });
  if (!addresses.length || !addresses.every(({ address }) => (isIPv4(address) && address.startsWith('127.')) || (isIPv6(address) && address === '::1'))) throw new Error('Handover sign-off tests require loopback-only MongoDB.');
  if (decodeURIComponent(parsed.pathname.replace(/^\//, '')) !== 'relay_round3_test') throw new Error('Handover sign-off tests require relay_round3_test.');
}

test('version-linked handover sign-off is assigned, atomic, append-only, and supersession-aware (local replica set only)', testOptions, async (t) => {
  await assertSafeTestUri(testUri);
  const envKeys = ['MONGODB_URI', 'JWT_SECRET', 'AUDIT_RETENTION_DAYS', 'SIGNOFF_RETENTION_DAYS'];
  const priorEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const userIds = [];
  const projectIds = [];
  const handoverIds = [];
  let server;
  try {
    process.env.MONGODB_URI = testUri;
    process.env.JWT_SECRET = 'relay-handover-signoff-local-test-key-for-integration';
    process.env.AUDIT_RETENTION_DAYS = '365';
    process.env.SIGNOFF_RETENTION_DAYS = '365';
    const [{ default: app }] = await Promise.all([import('../src/app.js')]);
    await mongoose.connect(testUri, { serverSelectionTimeoutMS: 2000 });
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    assert.ok(hello.setName && hello.isWritablePrimary, 'tests require an isolated transaction-capable replica set');
    await Promise.all([User.init(), Project.init(), ProjectAssignment.init(), Handover.init(), HandoverSignoff.init(), AuditEvent.init()]);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const users = {};
    for (const role of ['owner', 'creator', 'approver', 'secondApprover', 'viewer']) {
      const user = await User.create({ name: `Signoff ${role}`, email: `signoff-${role}-${new mongoose.Types.ObjectId()}@example.test`, passwordHash: 'integration-only' });
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
      name: `Signoff fixture ${new mongoose.Types.ObjectId()}`,
      owner: users.owner._id,
      workflowPolicy: { reviewMode: 'legacy_editors', signoffMode: 'assigned' },
      members: [
        { user: users.owner._id, role: 'owner' }, { user: users.creator._id, role: 'editor' },
        { user: users.approver._id, role: 'viewer' }, { user: users.secondApprover._id, role: 'viewer' }, { user: users.viewer._id, role: 'viewer' },
      ],
    });
    projectIds.push(project._id);
    const assignments = await ProjectAssignment.create([
      { project: project._id, user: users.approver._id, role: 'approver', scopeType: 'project', assignedBy: users.owner._id },
      { project: project._id, user: users.secondApprover._id, role: 'approver', scopeType: 'project', assignedBy: users.owner._id },
      { project: project._id, user: users.creator._id, role: 'approver', scopeType: 'project', assignedBy: users.owner._id },
    ]);

    await t.test('new handovers start pending and creator/unassigned/cross-project actors cannot sign', async () => {
      const generated = await api('creator', `/projects/${project._id}/handover`, { method: 'POST', body: '{}' });
      assert.equal(generated.status, 201);
      assert.equal(generated.data.handover.approvalStatus, 'pending');
      const handoverId = generated.data.handover._id;
      handoverIds.push(new mongoose.Types.ObjectId(handoverId));
      const self = await api('creator', `/handovers/${handoverId}/signoffs`, { method: 'POST', body: JSON.stringify({ decision: 'approved', comment: 'Cannot self approve.' }) });
      assert.equal(self.status, 403);
      const unassigned = await api('viewer', `/handovers/${handoverId}/signoffs`, { method: 'POST', body: JSON.stringify({ decision: 'approved', comment: 'Not assigned.' }) });
      assert.equal(unassigned.status, 403);
      const outsider = await api('viewer', `/handovers/${handoverId}/signoffs`, { method: 'POST', body: JSON.stringify({ decision: 'approved', comment: 'Cross project.' }), headers: { authorization: `Bearer ${jwt.sign({ sub: new mongoose.Types.ObjectId() }, process.env.JWT_SECRET)}` } });
      assert.equal(outsider.status, 401);
      const missingComment = await api('approver', `/handovers/${handoverId}/signoffs`, { method: 'POST', body: JSON.stringify({ decision: 'approved' }) });
      assert.equal(missingComment.status, 400);
      const missingReason = await api('approver', `/handovers/${handoverId}/signoffs`, { method: 'POST', body: JSON.stringify({ decision: 'rejected', comment: 'Rejecting.' }) });
      assert.equal(missingReason.status, 400);
    });

    await t.test('older pending version is computed superseded; rejection is terminal and new versions have fresh sign-offs', async () => {
      const firstId = String(handoverIds[0]);
      const second = await api('creator', `/projects/${project._id}/handover`, { method: 'POST', body: '{}' });
      assert.equal(second.status, 201);
      handoverIds.push(new mongoose.Types.ObjectId(second.data.handover._id));
      const oldSignoff = await api('approver', `/handovers/${firstId}/signoffs`, { method: 'POST', body: JSON.stringify({ decision: 'approved', comment: 'Outdated version.' }) });
      assert.equal(oldSignoff.status, 409);
      const oldStored = await Handover.findById(firstId).lean();
      assert.equal(oldStored.approvalStatus, 'pending', 'historical status is not rewritten');
      const rejection = await api('approver', `/handovers/${second.data.handover._id}/signoffs`, { method: 'POST', body: JSON.stringify({ decision: 'rejected', comment: 'Not ready.', reason: 'The handover requires a corrected owner list.' }) });
      assert.equal(rejection.status, 201);
      assert.equal(rejection.data.signoff.version, 2);
      const duplicate = await api('secondApprover', `/handovers/${second.data.handover._id}/signoffs`, { method: 'POST', body: JSON.stringify({ decision: 'approved', comment: 'Terminal rejection must stand.' }) });
      assert.equal(duplicate.status, 409);
      const third = await api('creator', `/projects/${project._id}/handover`, { method: 'POST', body: '{}' });
      assert.equal(third.status, 201);
      handoverIds.push(new mongoose.Types.ObjectId(third.data.handover._id));
      const history = await api('approver', `/handovers/${third.data.handover._id}/signoffs`);
      assert.equal(history.status, 200);
      assert.equal(history.data.signoffs.length, 0);
      assert.equal(history.data.effectiveStatus, 'pending');
      const list = await api('owner', `/projects/${project._id}/handovers`);
      assert.equal(list.data.handovers.find((item) => item.version === 1).effectiveStatus, 'superseded');
      assert.equal(list.data.handovers.find((item) => item.version === 2).effectiveStatus, 'rejected');
    });

    await t.test('sign-off and audit update roll back together when retention configuration is unavailable', async () => {
      const thirdId = String(handoverIds[2]);
      delete process.env.SIGNOFF_RETENTION_DAYS;
      const failed = await api('secondApprover', `/handovers/${thirdId}/signoffs`, { method: 'POST', body: JSON.stringify({ decision: 'approved', comment: 'Should roll back.' }) });
      assert.equal(failed.status, 503);
      assert.equal((await Handover.findById(thirdId).lean()).approvalStatus, 'pending');
      assert.equal(await HandoverSignoff.countDocuments({ handover: thirdId }), 0);
      process.env.SIGNOFF_RETENTION_DAYS = '365';
      const approved = await api('secondApprover', `/handovers/${thirdId}/signoffs`, { method: 'POST', body: JSON.stringify({ decision: 'approved', comment: 'Reviewed this exact version.' }) });
      assert.equal(approved.status, 201);
      assert.equal((await Handover.findById(thirdId).lean()).approvalStatus, 'approved');
      assert.equal(await AuditEvent.countDocuments({ projectId: project._id, action: 'handover.signoff.approved', targetId: thirdId }), 1);
      const history = await api('owner', `/handovers/${thirdId}/signoffs`);
      assert.equal(history.data.signoffs.length, 1);
    });

    assert.equal(assignments.length, 3);
  } finally {
    if (server) { server.close(); await once(server, 'close'); }
    if (mongoose.connection.readyState) {
      await Promise.all([
        AuditEvent.deleteMany({ projectId: { $in: projectIds } }), HandoverSignoff.deleteMany({ project: { $in: projectIds } }),
        Handover.deleteMany({ _id: { $in: handoverIds } }), ProjectAssignment.deleteMany({ project: { $in: projectIds } }),
        Project.deleteMany({ _id: { $in: projectIds } }), User.deleteMany({ _id: { $in: userIds } }),
      ]);
      await mongoose.disconnect();
    }
    for (const key of envKeys) {
      if (priorEnv[key] === undefined) delete process.env[key];
      else process.env[key] = priorEnv[key];
    }
  }
});
