import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/auth.js';
import { requireProjectAccess, requireProjectEditor } from '../middleware/projectAccess.js';
import Finding from '../models/Finding.js';
import Handover from '../models/Handover.js';
import ContradictionCandidate from '../models/ContradictionCandidate.js';
import HandoverSignoff from '../models/HandoverSignoff.js';
import AuditEvent from '../models/AuditEvent.js';
import ProjectAssignment from '../models/ProjectAssignment.js';
import Project from '../models/Project.js';
import { appendAuditEvent } from '../services/auditEvents.js';
import { claimApproverAssignment, isCurrentProjectMember } from '../services/projectAssignments.js';
import { effectiveHandoverStatus, validateSignoffDecision } from '../services/handoverSignoff.js';
import { retentionExpiry } from '../config/retention.js';
import { claimProjectRoleWrite } from '../services/projectLifecycle.js';
import { canReadProject } from '../services/projectPermissions.js';
import { acquireHandoverLock, allocateHandoverVersion, createHandoverSnapshot, renderHandoverPdf } from '../services/handoverReport.js';

const router = Router();
router.use(requireAuth);
const validId = (id) => /^[a-f\d]{24}$/i.test(id || '');
const LOCK_MS = 2 * 60 * 1000;
const selectedHandoverFields = 'project version reportContent findingIds approvalStatus createdBy createdAt updatedAt';

function handoverLockConflict() {
  const error = new Error('A handover version is already being generated for this project. Please wait and retry.');
  error.status = 409;
  error.code = 'HANDOVER_LOCK_UNAVAILABLE';
  return error;
}

router.post('/projects/:id/handover', requireProjectAccess, requireProjectEditor, async (req, res, next) => {
  const projectId = req.project._id;
  const lockToken = randomUUID();
  let locked = false;
  try {
    // Authorization and lock acquisition commit together. The generation
    // transaction below rechecks the role and lock token before writing.
    let acquired = false;
    const lockSession = await mongoose.startSession();
    try {
      await lockSession.withTransaction(async () => {
        await claimProjectRoleWrite(projectId, req.user._id, 'editor', lockSession);
        acquired = await acquireHandoverLock(Project, projectId, req.user._id, lockToken, new Date(), LOCK_MS, { session: lockSession });
        if (!acquired) throw handoverLockConflict();
      });
      locked = true;
    } finally { await lockSession.endSession(); }

    const approvedFindings = await Finding.find({ project: projectId, status: 'approved' })
      .populate('evidence.source', 'originalName').sort({ createdAt: 1, _id: 1 }).lean();
    const confirmedContradictions = await ContradictionCandidate.find({ project: projectId, status: 'confirmed_conflict' })
      .populate('reviewedBy', 'name email')
      .populate('evidence.source', 'originalName')
      .populate('evidence.sourceRevision', 'revisionKey capturedAt providerUpdatedAt')
      .sort({ reviewedAt: 1, _id: 1 }).lean();
    let handover;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const currentProject = await claimProjectRoleWrite(projectId, req.user._id, 'editor', session);
        const heldLock = await Project.findOne({
          _id: projectId,
          handoverLockToken: lockToken,
          handoverLockExpiresAt: { $gt: new Date() },
          $or: [{ deletionState: 'active' }, { deletionState: { $exists: false } }],
        }).session(session).select('_id').lean();
        if (!heldLock) throw handoverLockConflict();
        const version = await allocateHandoverVersion(Project, Handover, projectId, { session });
        const reportContent = createHandoverSnapshot({ project: currentProject, approvedFindings, confirmedContradictions, version, generatedBy: req.user });
        [handover] = await Handover.create([{
          project: projectId,
          version,
          reportContent,
          findingIds: approvedFindings.map((finding) => finding._id),
          createdBy: req.user._id,
          approvalStatus: currentProject.workflowPolicy?.signoffMode === 'assigned' ? 'pending' : 'draft',
        }], { session });
      });
    } finally { await session.endSession(); }
    return res.status(201).json({ handover });
  } catch (error) {
    if (error?.code === 'HANDOVER_LOCK_UNAVAILABLE') return res.status(409).json({ message: error.message });
    return next(error);
  }
  finally {
    if (locked) {
      try { await Project.updateOne({ _id: projectId, handoverLockToken: lockToken }, { $unset: { handoverLockToken: 1, handoverLockExpiresAt: 1 } }); }
      catch (error) { console.error(JSON.stringify({ level: 'error', operation: 'handover.releaseLock', projectId: String(projectId), name: error.name || 'Error' })); }
    }
  }
});

router.get('/projects/:id/handovers', requireProjectAccess, async (req, res, next) => {
  try {
    const handovers = await Handover.find({ project: req.project._id }).select(selectedHandoverFields)
      .populate('createdBy', 'name email').sort({ version: -1 }).lean();
    const latestVersion = handovers[0]?.version || 0;
    return res.json({ handovers: handovers.map((handover) => ({ ...handover, effectiveStatus: effectiveHandoverStatus(handover, latestVersion) })) });
  } catch (error) { return next(error); }
});

async function accessibleHandover(req, res, next) {
  try {
    if (!validId(req.params.handoverId)) return res.status(400).json({ message: 'Invalid handover ID.' });
    const handover = await Handover.findById(req.params.handoverId).select(selectedHandoverFields).populate('createdBy', 'name email').lean();
    if (!handover) return res.status(404).json({ message: 'Handover not found.' });
    const project = await Project.findById(handover.project);
    if (!project || !canReadProject(project, req.user._id)) return res.status(403).json({ message: 'You do not have access to this handover.' });
    if (project.deletionState && project.deletionState !== 'active') return res.status(410).json({ message: 'This project is in its deletion recovery lifecycle and is temporarily unavailable.' });
    req.handover = handover;
    req.project = project;
    return next();
  } catch (error) { return next(error); }
}

router.get('/handovers/:handoverId', accessibleHandover, async (req, res, next) => {
  try {
    const latest = await Handover.findOne({ project: req.project._id }).sort({ version: -1 }).select('version').lean();
    return res.json({ handover: { ...req.handover, effectiveStatus: effectiveHandoverStatus(req.handover, latest?.version || 0) } });
  } catch (error) { return next(error); }
});

async function withSignoffTransaction(work) {
  await Promise.all([Handover.init(), HandoverSignoff.init(), AuditEvent.init(), ProjectAssignment.init()]);
  const session = await mongoose.startSession();
  try { return await session.withTransaction(() => work(session)); }
  finally { await session.endSession(); }
}

router.post('/handovers/:handoverId/signoffs', accessibleHandover, async (req, res, next) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
      || Object.keys(req.body).some((key) => !['decision', 'comment', 'reason'].includes(key))) {
      return res.status(400).json({ message: 'Provide decision, comment, and a rejection reason where required.' });
    }
    const { decision, comment } = req.body;
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : undefined;
    const signoff = await withSignoffTransaction(async (session) => {
      const project = await Project.findById(req.handover.project).session(session);
      if (!project || !isCurrentProjectMember(project, req.user._id)) {
        const error = new Error('You do not have access to this handover.'); error.status = 403; throw error;
      }
      if (project.workflowPolicy?.signoffMode !== 'assigned') {
        const error = new Error('Formal sign-off is not enabled for this project.'); error.status = 409; throw error;
      }
      // This write conflicts with the handover-version allocator. It serializes
      // sign-off eligibility with a concurrently generated newer version.
      const activeProjectWrite = await Project.updateOne(
        { _id: project._id, $or: [{ deletionState: 'active' }, { deletionState: { $exists: false } }] },
        { $inc: { signoffLockCounter: 1, deletionGuardVersion: 1 } },
        { session, timestamps: false },
      );
      if (!activeProjectWrite.matchedCount) { const error = new Error('Project deletion has started; sign-off was not saved.'); error.status = 410; throw error; }
      const handover = await Handover.findOne({ _id: req.handover._id, project: project._id }).session(session);
      if (!handover) { const error = new Error('Handover not found.'); error.status = 404; throw error; }
      const latest = await Handover.findOne({ project: project._id }).sort({ version: -1 }).select('version').session(session).lean();
      validateSignoffDecision({ handover, latestVersion: latest?.version || 0, actorId: req.user._id, decision, comment, reason });
      const assignment = await claimApproverAssignment({ projectId: project._id, userId: req.user._id, handoverId: handover._id, session });
      if (!assignment) { const error = new Error('An active approver assignment for this handover is required.'); error.status = 403; throw error; }
      const nextStatus = decision === 'approved' ? 'approved' : 'rejected';
      const updated = await Handover.findOneAndUpdate(
        { _id: handover._id, project: project._id, version: handover.version, approvalStatus: 'pending' },
        { $set: { approvalStatus: nextStatus } },
        { new: true, session },
      );
      if (!updated) { const error = new Error('This handover already has a terminal sign-off decision.'); error.status = 409; throw error; }
      const [saved] = await HandoverSignoff.create([{
        project: project._id, handover: handover._id, version: handover.version,
        signer: req.user._id, assignment: assignment._id, decision,
        ...(reason ? { reason } : {}), comment: comment.trim(), expiresAt: retentionExpiry('signoff'),
      }], { session });
      await appendAuditEvent({
        projectId: project._id, actorId: req.user._id, action: `handover.signoff.${decision}`,
        targetType: 'handover', targetId: handover._id, reason, comment: comment.trim(), session,
      });
      return saved;
    });
    return res.status(201).json({ signoff });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ message: 'A sign-off already exists for this user and handover version.' });
    if (error?.code === 'RETENTION_CONFIGURATION_INVALID') return res.status(503).json({ message: 'Sign-off retention is not configured; the decision was not saved.' });
    if (error.status) return res.status(error.status).json({ message: error.message });
    return next(error);
  }
});

router.get('/handovers/:handoverId/signoffs', accessibleHandover, async (req, res, next) => {
  try {
    const signoffs = await HandoverSignoff.find({ handover: req.handover._id, project: req.project._id })
      .populate('signer', 'name email').sort({ createdAt: 1, _id: 1 }).lean();
    const latest = await Handover.findOne({ project: req.project._id }).sort({ version: -1 }).select('version').lean();
    return res.json({ signoffs, effectiveStatus: effectiveHandoverStatus(req.handover, latest?.version || 0) });
  } catch (error) { return next(error); }
});

router.get('/handovers/:handoverId/download', accessibleHandover, async (req, res, next) => {
  try {
    const pdf = await renderHandoverPdf(req.handover.reportContent || {});
    const filename = `relay-handover-v${req.handover.version}.pdf`;
    return res.status(200).set({
      'Content-Type': 'application/pdf',
      'Content-Length': String(pdf.length),
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    }).send(pdf);
  } catch (error) { return next(error); }
});

export default router;
