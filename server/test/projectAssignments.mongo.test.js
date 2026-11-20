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
import AuditEvent from '../src/models/AuditEvent.js';
import Finding from '../src/models/Finding.js';
import ReviewHistory from '../src/models/ReviewHistory.js';
import Handover from '../src/models/Handover.js';

const testUri = process.env.RELAY_TEST_MONGODB_URI;
const testOptions = testUri ? { skip: false } : { skip: 'Set RELAY_TEST_MONGODB_URI to an isolated local replica-set database.' };
const validId = (value) => /^[a-f\d]{24}$/i.test(value || '');

async function assertSafeTestUri(uri) {
  let parsed;
  try { parsed = new URL(uri); } catch { throw new Error('RELAY_TEST_MONGODB_URI must be a valid local mongodb:// URI.'); }
  if (parsed.protocol !== 'mongodb:' || !['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname)) {
    throw new Error('Project assignment integration tests refuse non-local MongoDB hosts.');
  }
  const addresses = await lookup(parsed.hostname.replace(/^\[|\]$/g, ''), { all: true });
  if (!addresses.length || !addresses.every(({ address }) => (
    (isIPv4(address) && address.startsWith('127.')) || (isIPv6(address) && address === '::1')
  ))) throw new Error('Project assignment integration tests require a loopback-only MongoDB host.');
  if (!/(?:^|[_-])test$/i.test(decodeURIComponent(parsed.pathname.replace(/^\//, '')))) {
    throw new Error('Project assignment integration tests require a database name ending in _test or -test.');
  }
}

async function runWithProjectMutationBeforeTransactionalRoleGuard(projectId, mutation, work) {
  const originalUpdateOne = Project.updateOne;
  let injected = false;
  Project.updateOne = function guardedUpdateOne(filter, update, options = {}) {
    const isRoleGuard = Boolean(options?.session && update?.$inc?.deletionGuardVersion);
    if (!injected && isRoleGuard) {
      injected = true;
      return (async () => {
        await originalUpdateOne.call(Project, { _id: projectId }, mutation.update, mutation.options || {});
        return originalUpdateOne.call(Project, filter, update, options);
      })();
    }
    return originalUpdateOne.call(Project, filter, update, options);
  };
  try {
    const result = await work();
    assert.equal(injected, true, 'the test must mutate project state after middleware and before the transactional role guard');
    return result;
  } finally {
    Project.updateOne = originalUpdateOne;
  }
}

async function runWithProjectMutationAfterHandoverLock(projectId, mutation, work) {
  const originalFind = Finding.find;
  let injected = false;
  Finding.find = function mutateAfterLock(...args) {
    const query = originalFind.apply(Finding, args);
    if (injected) return query;
    injected = true;
    const originalExec = query.exec.bind(query);
    query.exec = async (...execArgs) => {
      await Project.updateOne({ _id: projectId }, mutation.update, mutation.options || {});
      return originalExec(...execArgs);
    };
    return query;
  };
  try {
    const result = await work();
    assert.equal(injected, true, 'the role change must happen after lock acquisition and before generation');
    return result;
  } finally {
    Finding.find = originalFind;
  }
}

async function changeProjectRoleOnTransactionRetry(projectId, mutation, work) {
  const originalStartSession = mongoose.startSession;
  let intercepted = false;
  let attempts = 0;
  mongoose.startSession = async function startSessionWithRetry(...args) {
    const session = await originalStartSession.apply(mongoose, args);
    if (intercepted) return session;
    intercepted = true;
    const originalWithTransaction = session.withTransaction.bind(session);
    session.withTransaction = (callback, options) => originalWithTransaction(async () => {
      attempts += 1;
      if (attempts === 2) await Project.updateOne({ _id: projectId }, mutation.update, mutation.options || {});
      await callback(session);
      if (attempts === 1) {
        const transient = new mongoose.mongo.MongoServerError({ message: 'Simulated transient transaction conflict for authorization retry coverage.' });
        transient.addErrorLabel('TransientTransactionError');
        throw transient;
      }
    }, options);
    return session;
  };
  try {
    const result = await work();
    assert.equal(attempts, 2, 'the transaction callback must be retried once');
    return result;
  } finally {
    mongoose.startSession = originalStartSession;
  }
}

test('project assignment and permission integration (local replica set only)', testOptions, async (t) => {
  await assertSafeTestUri(testUri);
  const previousEnv = Object.fromEntries(['MONGODB_URI', 'JWT_SECRET', 'AUDIT_RETENTION_DAYS'].map((key) => [key, process.env[key]]));
  const ownedProjectIds = [];
  const ownedUserIds = [];
  let server;
  try {
    // Override only this test process. The URI was checked above and is never
    // loaded from the application's environment file or MONGODB_URI.
    process.env.MONGODB_URI = testUri;
    process.env.JWT_SECRET = 'round3-local-integration-test-signing-key-longer';
    process.env.AUDIT_RETENTION_DAYS = '365';
    const [{ default: app }] = await Promise.all([import('../src/app.js')]);

    await mongoose.connect(testUri, { serverSelectionTimeoutMS: 2000 });
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    assert.ok(hello.setName, 'MongoDB must be a replica set.');
    assert.ok(hello.isWritablePrimary, 'MongoDB replica set must have an elected primary.');
    await Promise.all([
      User.init(), Project.init(), ProjectAssignment.init(), AuditEvent.init(), Finding.init(), ReviewHistory.init(),
    ]);

    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const users = {};
    for (const role of ['owner', 'editor', 'viewer', 'outsider']) {
      const user = await User.create({
        name: `Round 3 ${role}`,
        email: `round3-${role}-${new mongoose.Types.ObjectId()}@example.test`,
        passwordHash: 'integration-test-only-hash',
      });
      users[role] = user;
      ownedUserIds.push(user._id);
    }
    const tokens = Object.fromEntries(Object.entries(users).map(([role, user]) => [
      role,
      jwt.sign({ sub: String(user._id) }, process.env.JWT_SECRET, { expiresIn: '10m' }),
    ]));
    const api = async (role, path, options = {}) => {
      const response = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers: {
          authorization: `Bearer ${tokens[role]}`,
          ...(options.body ? { 'content-type': 'application/json' } : {}),
          ...options.headers,
        },
      });
      const data = await response.json();
      return { status: response.status, data };
    };
    const createProject = async (name, workflowPolicy) => {
      const project = await Project.create({
        name,
        owner: users.owner._id,
        members: [{ user: users.owner._id, role: 'owner' }, { user: users.editor._id, role: 'editor' }, { user: users.viewer._id, role: 'viewer' }],
        ...(workflowPolicy ? { workflowPolicy } : {}),
      });
      ownedProjectIds.push(project._id);
      return project;
    };
    const addMember = async (projectId, user, role) => Project.updateOne(
      { _id: projectId }, { $addToSet: { members: { user: user._id, role } } },
    );
    const assign = (projectId, role, body) => api('owner', `/projects/${projectId}/assignments`, {
      method: 'POST', body: JSON.stringify({ role, ...body }),
    });
    const createFinding = async (projectId, category) => {
      const finding = await Finding.create({ project: projectId, category, title: 'Test finding', description: 'Local integration fixture.' });
      return finding;
    };

    await t.test('new project workflow defaults and role/scope authorization', async () => {
      const response = await api('owner', '/projects', { method: 'POST', body: JSON.stringify({ name: 'Round 3 assigned project' }) });
      assert.equal(response.status, 201);
      const projectId = response.data.project._id;
      ownedProjectIds.push(new mongoose.Types.ObjectId(projectId));
      assert.equal(response.data.project.workflowPolicy.reviewMode, 'assigned');
      assert.equal(response.data.project.workflowPolicy.signoffMode, 'assigned');

      await addMember(projectId, users.editor, 'editor');
      await addMember(projectId, users.viewer, 'viewer');
      const decisionFinding = await createFinding(projectId, 'Decision');
      const riskFinding = await createFinding(projectId, 'Risks');

      assert.equal((await api('editor', `/findings/${decisionFinding._id}/approve`, { method: 'POST', body: '{}' })).status, 403);
      assert.equal((await api('owner', `/findings/${decisionFinding._id}/approve`, { method: 'POST', body: '{}' })).status, 403);
      assert.equal((await api('viewer', `/projects/${projectId}`, { method: 'PUT', body: JSON.stringify({ name: 'Unauthorized edit' }) })).status, 403);
      assert.equal((await api('editor', `/projects/${projectId}/assignments`, {
        method: 'POST', body: JSON.stringify({ userId: users.viewer._id, role: 'reviewer' }),
      })).status, 403);

      const reviewer = await assign(projectId, 'reviewer', { userId: users.viewer._id, scopeType: 'category', scopeValue: 'Decision' });
      assert.equal(reviewer.status, 201);
      assert.equal((await api('viewer', `/findings/${decisionFinding._id}`, {
        method: 'PATCH', body: JSON.stringify({ category: 'Risks' }),
      })).status, 403);
      const duplicate = await assign(projectId, 'reviewer', { userId: users.viewer._id, scopeType: 'category', scopeValue: 'Decision' });
      assert.equal(duplicate.status, 409);
      assert.equal((await api('viewer', `/findings/${decisionFinding._id}/approve`, { method: 'POST', body: '{}' })).status, 200);
      assert.equal((await api('viewer', `/findings/${riskFinding._id}/approve`, { method: 'POST', body: '{}' })).status, 403);

      const approver = await assign(projectId, 'approver', { userId: users.viewer._id, scopeType: 'project' });
      assert.equal(approver.status, 201);
      const editorApprover = await assign(projectId, 'approver', { userId: users.editor._id, scopeType: 'project' });
      assert.equal(editorApprover.status, 201);
      assert.equal((await api('editor', `/findings/${riskFinding._id}/approve`, { method: 'POST', body: '{}' })).status, 403);
      const auditReader = await assign(projectId, 'audit_reader', { userId: users.viewer._id, scopeType: 'category', scopeValue: 'Decision' });
      assert.equal(auditReader.status, 201);
      assert.equal((await api('editor', `/projects/${projectId}/audit-events`)).status, 403);
      const auditRead = await api('viewer', `/projects/${projectId}/audit-events`);
      assert.equal(auditRead.status, 200);
      assert.ok(auditRead.data.events.length > 0);
      assert.ok(auditRead.data.events.every((event) => event.scopeType === 'category' && event.scopeValue === 'Decision'));
      assert.equal((await api('owner', `/projects/${projectId}/audit-events`)).status, 200);

      const activeAssignments = await ProjectAssignment.find({ project: projectId, status: 'active' }).lean();
      assert.equal(activeAssignments.length, 4);
      assert.equal(await ProjectAssignment.countDocuments({ project: projectId, role: 'reviewer', status: 'active' }), 1);
    });

    await t.test('audit-reader assignment grants audit read only', async () => {
      const project = await createProject(`Round 3 audit-reader only ${new mongoose.Types.ObjectId()}`);
      const finding = await createFinding(project._id, 'Decision');
      const auditReader = await assign(project._id, 'audit_reader', { userId: users.viewer._id, scopeType: 'project' });
      assert.equal(auditReader.status, 201);
      assert.equal((await api('viewer', `/projects/${project._id}/audit-events`)).status, 200);
      assert.equal((await api('viewer', `/findings/${finding._id}/approve`, { method: 'POST', body: '{}' })).status, 403);
      assert.equal((await api('viewer', `/projects/${project._id}`, { method: 'PUT', body: JSON.stringify({ name: 'Unauthorized edit' }) })).status, 403);
    });

    await t.test('legacy project behavior is preserved until owner opts into assigned review', async () => {
      const project = await createProject(`Round 3 legacy ${new mongoose.Types.ObjectId()}`);
      const finding = await createFinding(project._id, 'Decision');
      assert.equal(project.workflowPolicy.reviewMode, 'legacy_editors');
      process.env.AUDIT_RETENTION_DAYS = '0';
      assert.equal((await api('editor', `/findings/${finding._id}/approve`, { method: 'POST', body: '{}' })).status, 503);
      assert.equal((await Finding.findById(finding._id)).status, 'pending');
      assert.equal(await ReviewHistory.countDocuments({ finding: finding._id }), 0);
      process.env.AUDIT_RETENTION_DAYS = '365';
      assert.equal((await api('editor', `/findings/${finding._id}/approve`, { method: 'POST', body: '{}' })).status, 200);
      assert.equal((await api('owner', `/projects/${project._id}/workflow-policy`, {
        method: 'PATCH', body: JSON.stringify({ reviewMode: 'assigned' }),
      })).status, 409);
      assert.equal((await api('owner', `/projects/${project._id}/workflow-policy`, {
        method: 'PATCH', body: JSON.stringify({ signoffMode: 'assigned' }),
      })).status, 409);
      const assigned = await assign(project._id, 'reviewer', { userId: users.viewer._id, scopeType: 'project' });
      assert.equal(assigned.status, 201);
      const optedIn = await api('owner', `/projects/${project._id}/workflow-policy`, {
        method: 'PATCH', body: JSON.stringify({ reviewMode: 'assigned' }),
      });
      assert.equal(optedIn.status, 200);
      assert.equal(optedIn.data.workflowPolicy.reviewMode, 'assigned');
      assert.equal((await api('editor', `/findings/${finding._id}/reopen`, { method: 'POST', body: JSON.stringify({ reason: 'Legacy workflow changed.' }) })).status, 403);
      const secondFinding = await createFinding(project._id, 'Risks');
      assert.equal((await api('viewer', `/findings/${secondFinding._id}/approve`, { method: 'POST', body: '{}' })).status, 200);
    });

    await t.test('reassignment and revocation preserve assignment history', async () => {
      const project = await createProject(`Round 3 assignment history ${new mongoose.Types.ObjectId()}`);
      const oldAssignment = await assign(project._id, 'reviewer', { userId: users.viewer._id, scopeType: 'project' });
      assert.equal(oldAssignment.status, 201);
      const reassigned = await api('owner', `/projects/${project._id}/assignments/${oldAssignment.data.assignment._id}/reassign`, {
        method: 'POST', body: JSON.stringify({ userId: users.editor._id, role: 'reviewer', scopeType: 'category', scopeValue: 'Risks', reason: 'Reviewer changed.' }),
      });
      assert.equal(reassigned.status, 201);
      assert.equal((await api('owner', `/projects/${project._id}/members/${users.editor._id}`, {
        method: 'PATCH', body: JSON.stringify({ role: 'viewer' }),
      })).status, 200);
      assert.equal(await ProjectAssignment.countDocuments({ _id: reassigned.data.assignment._id, status: 'active' }), 1);
      const revoked = await api('owner', `/projects/${project._id}/assignments/${reassigned.data.assignment._id}/revoke`, {
        method: 'POST', body: JSON.stringify({ reason: 'Review duty completed.' }),
      });
      assert.equal(revoked.status, 200);
      const history = await api('owner', `/projects/${project._id}/assignments`);
      assert.equal(history.status, 200);
      assert.equal(history.data.assignments.length, 2);
      assert.equal(history.data.assignments.filter((item) => item.status === 'revoked').length, 2);
      assert.equal((await api('editor', `/projects/${project._id}/assignments`)).data.assignments.every((item) => item.status === 'active'), true);
      const finding = await createFinding(project._id, 'Risks');
      assert.equal((await api('editor', `/findings/${finding._id}/approve`, { method: 'POST', body: '{}' })).status, 403);
    });

    await t.test('member removal and assignment revocation commit or roll back together', async () => {
      const project = await createProject(`Round 3 atomic removal ${new mongoose.Types.ObjectId()}`);
      await assign(project._id, 'reviewer', { userId: users.viewer._id, scopeType: 'project' });
      await assign(project._id, 'audit_reader', { userId: users.viewer._id, scopeType: 'project' });

      process.env.AUDIT_RETENTION_DAYS = '0';
      const failedRemoval = await api('owner', `/projects/${project._id}/members/${users.viewer._id}`, { method: 'DELETE' });
      assert.equal(failedRemoval.status, 503);
      const afterRollback = await Project.findById(project._id).lean();
      assert.ok(afterRollback.members.some((member) => String(member.user) === String(users.viewer._id)));
      assert.equal(await ProjectAssignment.countDocuments({ project: project._id, user: users.viewer._id, status: 'active' }), 2);

      process.env.AUDIT_RETENTION_DAYS = '365';
      const removed = await api('owner', `/projects/${project._id}/members/${users.viewer._id}`, { method: 'DELETE' });
      assert.equal(removed.status, 200);
      const afterCommit = await Project.findById(project._id).lean();
      assert.ok(!afterCommit.members.some((member) => String(member.user) === String(users.viewer._id)));
      assert.equal(await ProjectAssignment.countDocuments({ project: project._id, user: users.viewer._id, status: 'active' }), 0);
      assert.equal(await ProjectAssignment.countDocuments({ project: project._id, user: users.viewer._id, status: 'revoked' }), 2);
      assert.equal((await api('viewer', `/projects/${project._id}/assignments`)).status, 403);
    });

    await t.test('assignment routes reject non-members and cross-project IDs', async () => {
      const project = await createProject(`Round 3 isolation ${new mongoose.Types.ObjectId()}`);
      assert.equal((await assign(project._id, 'reviewer', { userId: users.outsider._id, scopeType: 'project' })).status, 404);
      const own = await assign(project._id, 'reviewer', { userId: users.viewer._id, scopeType: 'project' });
      assert.equal(own.status, 201);
      const otherProject = await createProject(`Round 3 other project ${new mongoose.Types.ObjectId()}`);
      const crossProject = await api('owner', `/projects/${otherProject._id}/assignments/${own.data.assignment._id}/revoke`, {
        method: 'POST', body: JSON.stringify({ reason: 'Should not cross project.' }),
      });
      assert.equal(crossProject.status, 404);
    });

    await t.test('owner-only assignment and workflow writes reject an ownership transfer in flight', async () => {
      const cases = [
        { name: 'assignment creation', run: (project) => api('owner', `/projects/${project._id}/assignments`, { method: 'POST', body: JSON.stringify({ userId: users.viewer._id, role: 'reviewer', scopeType: 'project' }) }) },
        { name: 'assignment revocation', prepare: async (project) => (await assign(project._id, 'reviewer', { userId: users.viewer._id, scopeType: 'project' })).data.assignment._id, run: (project, assignmentId) => api('owner', `/projects/${project._id}/assignments/${assignmentId}/revoke`, { method: 'POST', body: JSON.stringify({ reason: 'race regression' }) }) },
        { name: 'assignment reassignment', prepare: async (project) => (await assign(project._id, 'reviewer', { userId: users.viewer._id, scopeType: 'project' })).data.assignment._id, run: (project, assignmentId) => api('owner', `/projects/${project._id}/assignments/${assignmentId}/reassign`, { method: 'POST', body: JSON.stringify({ userId: users.editor._id, role: 'reviewer', scopeType: 'project', reason: 'race regression' }) }) },
        { name: 'workflow policy update', run: (project) => api('owner', `/projects/${project._id}/workflow-policy`, { method: 'PATCH', body: JSON.stringify({ signoffMode: 'none' }) }) },
      ];

      for (const operation of cases) {
        const project = await createProject(`Round 3 owner race ${operation.name} ${new mongoose.Types.ObjectId()}`);
        const beforeCount = await ProjectAssignment.countDocuments({ project: project._id });
        const beforeSignoffMode = project.workflowPolicy.signoffMode;
        const assignmentId = await operation.prepare?.(project);
        const beforeAssignments = await ProjectAssignment.find({ project: project._id }).sort({ _id: 1 }).lean();
        const response = await runWithProjectMutationBeforeTransactionalRoleGuard(
          project._id,
          { update: { $set: { owner: users.editor._id } } },
          () => operation.run(project, assignmentId),
        );
        assert.equal(response.status, 403, `${operation.name} must reject the former owner`);
        assert.equal(String((await Project.findById(project._id).lean()).owner), String(users.editor._id));
        const afterAssignments = await ProjectAssignment.find({ project: project._id }).sort({ _id: 1 }).lean();
        assert.deepEqual(afterAssignments.map((item) => ({ id: String(item._id), status: item.status, user: String(item.user) })), beforeAssignments.map((item) => ({ id: String(item._id), status: item.status, user: String(item.user) })));
        assert.equal(await ProjectAssignment.countDocuments({ project: project._id }), beforeCount + (assignmentId ? 1 : 0));
        assert.equal((await Project.findById(project._id).lean()).workflowPolicy.signoffMode, beforeSignoffMode);
        await Project.updateOne({ _id: project._id }, { $set: { owner: users.owner._id } });
      }
    });

    await t.test('legacy review rejects an editor role revoked while the write is in flight', async () => {
      const project = await createProject(`Round 3 review role race ${new mongoose.Types.ObjectId()}`);
      const finding = await createFinding(project._id, 'Decision');
      const response = await runWithProjectMutationBeforeTransactionalRoleGuard(
        project._id,
        { update: { $set: { 'members.$[target].role': 'viewer' } }, options: { arrayFilters: [{ 'target.user': users.editor._id }] } },
        () => api('editor', `/findings/${finding._id}/approve`, { method: 'POST', body: '{}' }),
      );
      assert.equal(response.status, 403);
      assert.equal((await Finding.findById(finding._id).lean()).status, 'pending');
      assert.equal(await ReviewHistory.countDocuments({ project: project._id, finding: finding._id }), 0);
      assert.equal(await AuditEvent.countDocuments({ projectId: project._id, action: 'finding.approved', targetId: finding._id }), 0);
    });

    await t.test('transaction retry rechecks owner authorization before assignment writes', async () => {
      const project = await createProject(`Round 3 transaction retry role race ${new mongoose.Types.ObjectId()}`);
      const response = await changeProjectRoleOnTransactionRetry(
        project._id,
        { update: { $set: { owner: users.editor._id } } },
        () => api('owner', `/projects/${project._id}/assignments`, { method: 'POST', body: JSON.stringify({ userId: users.viewer._id, role: 'reviewer', scopeType: 'project' }) }),
      );
      assert.equal(response.status, 403);
      assert.equal(await ProjectAssignment.countDocuments({ project: project._id }), 0);
      assert.equal(await AuditEvent.countDocuments({ projectId: project._id, action: 'assignment.assigned' }), 0);
      assert.equal(String((await Project.findById(project._id).lean()).owner), String(users.editor._id));
    });

    await t.test('handover generation rejects editor membership removal before reserving a version', async () => {
      const project = await createProject(`Round 3 handover membership race ${new mongoose.Types.ObjectId()}`);
      const response = await runWithProjectMutationBeforeTransactionalRoleGuard(
        project._id,
        { update: { $pull: { members: { user: users.editor._id } } } },
        () => api('editor', `/projects/${project._id}/handover`, { method: 'POST', body: '{}' }),
      );
      assert.equal(response.status, 403);
      assert.equal(await Handover.countDocuments({ project: project._id }), 0);
      const after = await Project.findById(project._id).select('+handoverVersionCounter handoverLockToken').lean();
      assert.equal(after.handoverVersionCounter || 0, 0);
      assert.equal(after.handoverLockToken, undefined);
    });

    await t.test('demoted editor cannot acquire a handover lock', async () => {
      const project = await createProject(`Round 3 handover demotion before lock ${new mongoose.Types.ObjectId()}`);
      const response = await runWithProjectMutationBeforeTransactionalRoleGuard(
        project._id,
        { update: { $set: { 'members.$[target].role': 'viewer' } }, options: { arrayFilters: [{ 'target.user': users.editor._id }] } },
        () => api('editor', `/projects/${project._id}/handover`, { method: 'POST', body: '{}' }),
      );
      assert.equal(response.status, 403);
      assert.equal((await Project.findById(project._id).select('handoverLockToken').lean()).handoverLockToken, undefined);
      assert.equal(await Handover.countDocuments({ project: project._id }), 0);
    });

    await t.test('removed member cannot acquire a handover lock', async () => {
      const project = await createProject(`Round 3 handover removal before lock ${new mongoose.Types.ObjectId()}`);
      const response = await runWithProjectMutationBeforeTransactionalRoleGuard(
        project._id,
        { update: { $pull: { members: { user: users.editor._id } } } },
        () => api('editor', `/projects/${project._id}/handover`, { method: 'POST', body: '{}' }),
      );
      assert.equal(response.status, 403);
      assert.equal((await Project.findById(project._id).select('handoverLockToken').lean()).handoverLockToken, undefined);
      assert.equal(await Handover.countDocuments({ project: project._id }), 0);
    });

    await t.test('pending deletion prevents handover lock acquisition', async () => {
      const project = await createProject(`Round 3 handover deleting before lock ${new mongoose.Types.ObjectId()}`);
      const response = await runWithProjectMutationBeforeTransactionalRoleGuard(
        project._id,
        { update: { $set: { deletionState: 'queued' } } },
        () => api('owner', `/projects/${project._id}/handover`, { method: 'POST', body: '{}' }),
      );
      assert.equal(response.status, 410);
      const after = await Project.findById(project._id).select('handoverLockToken handoverLockExpiresAt').lean();
      assert.equal(after.handoverLockToken, undefined);
      assert.equal(after.handoverLockExpiresAt, undefined);
      assert.equal(await Handover.countDocuments({ project: project._id }), 0);
    });

    await t.test('role removal after lock acquisition rejects generation and releases the lock', async () => {
      const project = await createProject(`Round 3 handover demotion after lock ${new mongoose.Types.ObjectId()}`);
      const response = await runWithProjectMutationAfterHandoverLock(
        project._id,
        { update: { $set: { 'members.$[target].role': 'viewer' } }, options: { arrayFilters: [{ 'target.user': users.editor._id }] } },
        () => api('editor', `/projects/${project._id}/handover`, { method: 'POST', body: '{}' }),
      );
      assert.equal(response.status, 403);
      const after = await Project.findById(project._id).select('handoverLockToken handoverLockExpiresAt +handoverVersionCounter').lean();
      assert.equal(after.handoverLockToken, undefined);
      assert.equal(after.handoverLockExpiresAt, undefined);
      assert.equal(after.handoverVersionCounter || 0, 0);
      assert.equal(await Handover.countDocuments({ project: project._id }), 0);
    });

    await t.test('aborted handover creation releases its committed lock', async () => {
      const project = await createProject(`Round 3 handover abort cleanup ${new mongoose.Types.ObjectId()}`);
      const originalCreate = Handover.create;
      Handover.create = async () => { throw new Error('Injected handover persistence failure.'); };
      let response;
      try { response = await api('owner', `/projects/${project._id}/handover`, { method: 'POST', body: '{}' }); }
      finally { Handover.create = originalCreate; }
      assert.equal(response.status, 500);
      const after = await Project.findById(project._id).select('handoverLockToken handoverLockExpiresAt +handoverVersionCounter').lean();
      assert.equal(after.handoverLockToken, undefined);
      assert.equal(after.handoverLockExpiresAt, undefined);
      assert.equal(after.handoverVersionCounter || 0, 0);
      assert.equal(await Handover.countDocuments({ project: project._id }), 0);
    });

    await t.test('concurrent valid handover requests admit one lock holder', async () => {
      const project = await createProject(`Round 3 concurrent handover locks ${new mongoose.Types.ObjectId()}`);
      const responses = await Promise.all([
        api('owner', `/projects/${project._id}/handover`, { method: 'POST', body: '{}' }),
        api('owner', `/projects/${project._id}/handover`, { method: 'POST', body: '{}' }),
      ]);
      assert.deepEqual(responses.map(({ status }) => status).sort((a, b) => a - b), [201, 409]);
      assert.equal(await Handover.countDocuments({ project: project._id }), 1);
      const after = await Project.findById(project._id).select('handoverLockToken handoverLockExpiresAt').lean();
      assert.equal(after.handoverLockToken, undefined);
      assert.equal(after.handoverLockExpiresAt, undefined);
    });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (mongoose.connection.readyState === 1) {
      if (ownedProjectIds.length) {
        await Promise.all([
          ProjectAssignment.deleteMany({ project: { $in: ownedProjectIds } }),
          AuditEvent.deleteMany({ projectId: { $in: ownedProjectIds } }),
          Finding.deleteMany({ project: { $in: ownedProjectIds } }),
          ReviewHistory.deleteMany({ project: { $in: ownedProjectIds } }),
          Handover.deleteMany({ project: { $in: ownedProjectIds } }),
          Project.deleteMany({ _id: { $in: ownedProjectIds } }),
        ]);
      }
      if (ownedUserIds.length) await User.deleteMany({ _id: { $in: ownedUserIds } });
      await mongoose.disconnect();
    }
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
