import { Router } from 'express';
import mongoose from 'mongoose';
import AuditEvent from '../models/AuditEvent.js';
import Handover from '../models/Handover.js';
import Project from '../models/Project.js';
import ProjectAssignment from '../models/ProjectAssignment.js';
import User from '../models/User.js';
import { requireAuth } from '../middleware/auth.js';
import { requireProjectAccess, requireProjectOwner } from '../middleware/projectAccess.js';
import { appendAuditEvent } from '../services/auditEvents.js';
import { canReadAuditEvents, isCurrentProjectMember, normalizeAssignmentInput, ProjectAssignmentError } from '../services/projectAssignments.js';
import { claimProjectRoleWrite } from '../services/projectLifecycle.js';

const router = Router();
router.use(requireAuth);
const validId = (id) => /^[a-f\d]{24}$/i.test(id || '');
const safeUserProjection = 'name email';

async function withTransaction(work) {
  await Promise.all([ProjectAssignment.init(), AuditEvent.init()]);
  const session = await mongoose.startSession();
  try { return await session.withTransaction(() => work(session)); }
  finally { await session.endSession(); }
}

function routeError(error, res, next) {
  if (error instanceof ProjectAssignmentError) return res.status(error.status).json({ message: error.message });
  if (error?.code === 11000) return res.status(409).json({ message: 'An active assignment already exists for this user and scope.' });
  if (error?.code === 'RETENTION_CONFIGURATION_INVALID') {
    return res.status(503).json({ message: 'Audit retention is not configured; the operation was not saved.' });
  }
  return next(error);
}

function requireOwnerBodyObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ProjectAssignmentError('Request body must be an object.');
}

async function validateTargetAndScope(project, userId, input, session) {
  if (!validId(userId)) throw new ProjectAssignmentError('A valid project member ID is required.');
  const currentProject = await Project.findById(project._id).session(session).lean();
  if (!currentProject || !isCurrentProjectMember(currentProject, userId)) {
    throw new ProjectAssignmentError('Assignments can only be given to current project members.', 404);
  }
  if (!await User.exists({ _id: userId }).session(session)) {
    throw new ProjectAssignmentError('The selected project member account no longer exists.', 404);
  }
  const assignment = normalizeAssignmentInput(input);
  if (assignment.scopeType === 'handover') {
    const handover = await Handover.exists({ _id: assignment.scopeValue, project: project._id }).session(session);
    if (!handover) throw new ProjectAssignmentError('The handover scope does not belong to this project.', 404);
  }
  return { currentProject, assignment, userId: new mongoose.Types.ObjectId(userId) };
}

function assignmentRecord({ projectId, userId, role, scopeType, scopeValue, assignedBy }) {
  return {
    project: projectId,
    user: userId,
    role,
    scopeType,
    scopeValue,
    assignedBy,
    assignedAt: new Date(),
    status: 'active',
  };
}

function publicAssignment(assignment) {
  const value = assignment?.toObject ? assignment.toObject() : { ...assignment };
  delete value.authorizationUseCount;
  return value;
}

async function appendAssignmentAudit({ projectId, actorId, assignment, action, reason, session }) {
  return appendAuditEvent({
    projectId,
    actorId,
    action,
    targetType: 'project_assignment',
    targetId: assignment._id,
    scopeType: assignment.scopeType,
    scopeValue: assignment.scopeValue,
    reason,
    session,
  });
}

router.get('/:id/assignments', requireProjectAccess, async (req, res, next) => {
  try {
    const isOwner = String(req.project.owner) === String(req.user._id);
    const query = { project: req.project._id, ...(isOwner ? {} : { status: 'active' }) };
    const assignments = await ProjectAssignment.find(query)
      .populate('user', safeUserProjection).populate('assignedBy', safeUserProjection)
      .populate('revokedBy', safeUserProjection).sort({ createdAt: -1 }).lean();
    return res.json({ assignments, canManageAssignments: isOwner });
  } catch (error) { return next(error); }
});

router.post('/:id/assignments', requireProjectAccess, requireProjectOwner, async (req, res, next) => {
  try {
    requireOwnerBodyObject(req.body);
    let created;
    await withTransaction(async (session) => {
      const currentProject = await claimProjectRoleWrite(req.project._id, req.user._id, 'owner', session);
      const { assignment, userId } = await validateTargetAndScope(currentProject, req.body.userId, req.body, session);
      [created] = await ProjectAssignment.create([assignmentRecord({
        projectId: req.project._id, userId, ...assignment, assignedBy: req.user._id,
      })], { session });
      await appendAssignmentAudit({ projectId: req.project._id, actorId: req.user._id, assignment: created, action: 'assignment.assigned', session });
    });
    await created.populate([{ path: 'user', select: safeUserProjection }, { path: 'assignedBy', select: safeUserProjection }]);
    return res.status(201).json({ assignment: publicAssignment(created) });
  } catch (error) { return routeError(error, res, next); }
});

router.post('/:id/assignments/:assignmentId/revoke', requireProjectAccess, requireProjectOwner, async (req, res, next) => {
  try {
    requireOwnerBodyObject(req.body);
    if (!validId(req.params.assignmentId)) return res.status(400).json({ message: 'Invalid assignment ID.' });
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    if (reason.length > 1000) return res.status(400).json({ message: 'Revocation reason must be 1,000 characters or fewer.' });
    let revoked;
    await withTransaction(async (session) => {
      await claimProjectRoleWrite(req.project._id, req.user._id, 'owner', session);
      revoked = await ProjectAssignment.findOneAndUpdate(
        { _id: req.params.assignmentId, project: req.project._id, status: 'active' },
        { $set: { status: 'revoked', revokedBy: req.user._id, revokedAt: new Date(), revokeReason: reason || undefined } },
        { new: true, session },
      );
      if (!revoked) throw new ProjectAssignmentError('Active assignment not found.', 404);
      await appendAssignmentAudit({ projectId: req.project._id, actorId: req.user._id, assignment: revoked, action: 'assignment.revoked', reason, session });
    });
    return res.json({ assignment: publicAssignment(revoked) });
  } catch (error) { return routeError(error, res, next); }
});

router.post('/:id/assignments/:assignmentId/reassign', requireProjectAccess, requireProjectOwner, async (req, res, next) => {
  try {
    requireOwnerBodyObject(req.body);
    if (!validId(req.params.assignmentId)) return res.status(400).json({ message: 'Invalid assignment ID.' });
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    if (reason.length > 1000) return res.status(400).json({ message: 'Reassignment reason must be 1,000 characters or fewer.' });
    let replacement;
    await withTransaction(async (session) => {
      const currentProject = await claimProjectRoleWrite(req.project._id, req.user._id, 'owner', session);
      const old = await ProjectAssignment.findOneAndUpdate(
        { _id: req.params.assignmentId, project: req.project._id, status: 'active' },
        { $set: { status: 'revoked', revokedBy: req.user._id, revokedAt: new Date(), revokeReason: reason || 'Reassigned' } },
        { new: true, session },
      );
      if (!old) throw new ProjectAssignmentError('Active assignment not found.', 404);
      const { assignment, userId } = await validateTargetAndScope(currentProject, req.body.userId, req.body, session);
      [replacement] = await ProjectAssignment.create([assignmentRecord({
        projectId: req.project._id, userId, ...assignment, assignedBy: req.user._id,
      })], { session });
      await appendAssignmentAudit({ projectId: req.project._id, actorId: req.user._id, assignment: old, action: 'assignment.reassigned_from', reason, session });
      await appendAssignmentAudit({ projectId: req.project._id, actorId: req.user._id, assignment: replacement, action: 'assignment.reassigned_to', reason, session });
    });
    await replacement.populate([{ path: 'user', select: safeUserProjection }, { path: 'assignedBy', select: safeUserProjection }]);
    return res.status(201).json({ assignment: publicAssignment(replacement) });
  } catch (error) { return routeError(error, res, next); }
});

router.patch('/:id/workflow-policy', requireProjectAccess, requireProjectOwner, async (req, res, next) => {
  try {
    requireOwnerBodyObject(req.body);
    const allowed = new Set(['reviewMode', 'signoffMode']);
    if (!Object.keys(req.body).length || Object.keys(req.body).some((key) => !allowed.has(key))) {
      return res.status(400).json({ message: 'Provide reviewMode and/or signoffMode only.' });
    }
    const { reviewMode, signoffMode } = req.body;
    if (reviewMode !== undefined && !['legacy_editors', 'assigned'].includes(reviewMode)) return res.status(400).json({ message: 'Invalid reviewMode.' });
    if (signoffMode !== undefined && !['none', 'assigned'].includes(signoffMode)) return res.status(400).json({ message: 'Invalid signoffMode.' });
    let updated;
    await withTransaction(async (session) => {
      const project = await claimProjectRoleWrite(req.project._id, req.user._id, 'owner', session);
      if (reviewMode === 'assigned' && !await ProjectAssignment.exists({ project: project._id, role: 'reviewer', status: 'active' }).session(session)) {
        throw new ProjectAssignmentError('Assign at least one reviewer before enabling assigned review.', 409);
      }
      if (signoffMode === 'assigned' && !await ProjectAssignment.exists({ project: project._id, role: 'approver', status: 'active' }).session(session)) {
        throw new ProjectAssignmentError('Assign at least one approver before enabling assigned sign-off.', 409);
      }
      const previous = { reviewMode: project.workflowPolicy?.reviewMode || 'legacy_editors', signoffMode: project.workflowPolicy?.signoffMode || 'none' };
      if (reviewMode !== undefined) project.workflowPolicy.reviewMode = reviewMode;
      if (signoffMode !== undefined) project.workflowPolicy.signoffMode = signoffMode;
      await project.save({ session });
      await appendAuditEvent({
        projectId: project._id, actorId: req.user._id, action: 'workflow_policy.updated',
        targetType: 'project', targetId: project._id,
        comment: `reviewMode ${previous.reviewMode} → ${project.workflowPolicy.reviewMode}; signoffMode ${previous.signoffMode} → ${project.workflowPolicy.signoffMode}`,
        session,
      });
      updated = project;
    });
    return res.json({ workflowPolicy: updated.workflowPolicy });
  } catch (error) { return routeError(error, res, next); }
});

router.get('/:id/audit-events', requireProjectAccess, async (req, res, next) => {
  try {
    const access = await canReadAuditEvents(req.project, req.user._id);
    if (!access.allowed) return res.status(403).json({ message: 'Audit history is restricted to project owners and assigned audit readers.' });
    const rawLimit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) return res.status(400).json({ message: 'limit must be a number from 1 to 100.' });
    const events = await AuditEvent.find(access.query).sort({ createdAt: -1, _id: -1 }).limit(rawLimit).lean();
    return res.json({ events });
  } catch (error) { return next(error); }
});

export default router;
