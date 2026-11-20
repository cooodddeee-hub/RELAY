import { Router } from 'express';
import mongoose from 'mongoose';
import AuditEvent from '../models/AuditEvent.js';
import ContradictionCandidate from '../models/ContradictionCandidate.js';
import Project from '../models/Project.js';
import ProjectAssignment from '../models/ProjectAssignment.js';
import { requireAuth } from '../middleware/auth.js';
import { requireProjectAccess, requireProjectEditor } from '../middleware/projectAccess.js';
import { appendAuditEvent } from '../services/auditEvents.js';
import { canReadAuditEvents, claimReviewerAssignment, isCurrentProjectMember, isReviewerScopeMatch } from '../services/projectAssignments.js';
import { canEditProject, projectRole } from '../services/projectPermissions.js';
import { detectContradictionCandidates, transitionContradiction } from '../services/contradictions.js';
import { claimActiveProjectWrite } from '../services/projectLifecycle.js';

const router = Router();
router.use(requireAuth);
const validId = (value) => /^[a-f\d]{24}$/i.test(value || '');
const allowedStatuses = new Set(['candidate', 'in_review', 'confirmed_conflict', 'stale_information', 'resolved', 'dismissed']);

async function withTransaction(work) {
  await Promise.all([ContradictionCandidate.init(), AuditEvent.init(), ProjectAssignment.init()]);
  const session = await mongoose.startSession();
  try { return await session.withTransaction(() => work(session)); }
  finally { await session.endSession(); }
}

router.get('/:id/contradictions', requireProjectAccess, async (req, res, next) => {
  try {
    const query = { project: req.project._id };
    if (req.query.status) {
      if (!allowedStatuses.has(req.query.status)) return res.status(400).json({ message: 'Invalid contradiction status.' });
      query.status = req.query.status;
    }
    const candidates = await ContradictionCandidate.find(query)
      .populate('claims.finding', 'title category')
      .populate('evidence.source', 'originalName provider externalType externalId repositoryLink')
      .populate('evidence.sourceRevision', 'revisionKey capturedAt providerUpdatedAt locator')
      .populate('reviewedBy', 'name email')
      .sort({ createdAt: -1, _id: -1 }).lean();
    return res.json({ candidates });
  } catch (error) { return next(error); }
});

router.post('/:id/contradictions/detect', requireProjectAccess, requireProjectEditor, async (req, res, next) => {
  try {
    if (req.body && Object.keys(req.body).length) return res.status(400).json({ message: 'Contradiction detection does not accept client-supplied findings or evidence.' });
    const result = await withTransaction(async (session) => {
      const project = await Project.findById(req.project._id).session(session);
      if (!project || !canEditProject(project, req.user._id)) {
        const error = new Error('Only current project owners and editors can detect contradiction candidates.');
        error.status = 403;
        throw error;
      }
      await claimActiveProjectWrite(project._id, session);
      return detectContradictionCandidates({
        projectId: project._id,
        actorId: req.user._id,
        session,
        audit: (candidate, activeSession) => appendAuditEvent({
          projectId: project._id, actorId: req.user._id, action: 'contradiction.candidate_detected',
          targetType: 'contradiction_candidate', targetId: candidate._id,
          comment: 'A cautious evidence-backed candidate was detected; human review is required.', session: activeSession,
        }),
      });
    });
    return res.status(200).json({ detectedPairs: result.detectedPairs, createdCount: result.created.length, candidates: result.created });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ message: 'A matching contradiction candidate was created concurrently. Refresh the candidate list.' });
    if (error?.code === 'RETENTION_CONFIGURATION_INVALID') return res.status(503).json({ message: 'Audit retention is not configured; no contradiction candidates were saved.' });
    if (error.status) return res.status(error.status).json({ message: error.message });
    return next(error);
  }
});

router.post('/:id/contradictions/:candidateId/review', requireProjectAccess, async (req, res, next) => {
  try {
    if (!validId(req.params.candidateId)) return res.status(400).json({ message: 'Invalid contradiction candidate ID.' });
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
      || Object.keys(req.body).some((key) => !['status', 'reason'].includes(key))) {
      return res.status(400).json({ message: 'Provide status and review reason only.' });
    }
    const status = req.body.status;
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    if (!['in_review', 'confirmed_conflict', 'stale_information', 'resolved', 'dismissed'].includes(status)) {
      return res.status(400).json({ message: 'Choose a valid human review decision.' });
    }
    if (!reason || reason.length > 2000) return res.status(400).json({ message: 'A reviewer rationale of 1 to 2,000 characters is required.' });

    const candidate = await withTransaction(async (session) => {
      const [project, current] = await Promise.all([
        Project.findById(req.project._id).session(session),
        ContradictionCandidate.findOne({ _id: req.params.candidateId, project: req.project._id }).session(session),
      ]);
      if (!current) {
        const error = new Error('Contradiction candidate not found.'); error.status = 404; throw error;
      }
      if (!project || !isCurrentProjectMember(project, req.user._id)) {
        const error = new Error('You do not have access to this contradiction candidate.'); error.status = 403; throw error;
      }
      await claimActiveProjectWrite(project._id, session);
      const role = projectRole(project, req.user._id);
      if (project.workflowPolicy?.reviewMode === 'assigned') {
        const categories = [...new Set((current.claims || []).map((claim) => claim.category).filter(Boolean))];
        const assignments = await ProjectAssignment.find({ project: project._id, user: req.user._id, role: 'reviewer', status: 'active' }).session(session).lean();
        const covered = categories.length > 0 && categories.every((category) => assignments.some((assignment) => isReviewerScopeMatch(assignment, { category })));
        if (!covered) {
          const error = new Error('An active reviewer assignment covering each candidate category is required.'); error.status = 403; throw error;
        }
        for (const category of categories) {
          if (!await claimReviewerAssignment({ projectId: project._id, userId: req.user._id, category, session })) {
            const error = new Error('Reviewer assignment was revoked before the decision could be saved.'); error.status = 403; throw error;
          }
        }
      } else if (!['owner', 'editor'].includes(role)) {
        const error = new Error('Only project owners and editors can review candidates in legacy review mode.'); error.status = 403; throw error;
      }
      transitionContradiction(current, status, req.user._id, reason);
      await current.save({ session });
      await appendAuditEvent({
        projectId: project._id, actorId: req.user._id, action: `contradiction.${status}`,
        targetType: 'contradiction_candidate', targetId: current._id,
        reason, comment: reason, session,
      });
      return current;
    });
    return res.json({ candidate });
  } catch (error) {
    if (error?.code === 'RETENTION_CONFIGURATION_INVALID') return res.status(503).json({ message: 'Audit retention is not configured; the review was not saved.' });
    if (error.status) return res.status(error.status).json({ message: error.message });
    return next(error);
  }
});

router.get('/:id/contradictions/:candidateId/history', requireProjectAccess, async (req, res, next) => {
  try {
    if (!validId(req.params.candidateId)) return res.status(400).json({ message: 'Invalid contradiction candidate ID.' });
    if (!await ContradictionCandidate.exists({ _id: req.params.candidateId, project: req.project._id })) return res.status(404).json({ message: 'Contradiction candidate not found.' });
    const access = await canReadAuditEvents(req.project, req.user._id);
    if (!access.allowed) return res.status(403).json({ message: 'Contradiction history is restricted to project owners and assigned audit readers.' });
    const events = await AuditEvent.find({ projectId: req.project._id, targetType: 'contradiction_candidate', targetId: req.params.candidateId })
      .populate('actorId', 'name email').sort({ createdAt: 1, _id: 1 }).lean();
    return res.json({ events });
  } catch (error) { return next(error); }
});

export default router;
