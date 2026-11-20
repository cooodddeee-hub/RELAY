import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/auth.js';
import { requireProjectAccess, requireProjectEditor } from '../middleware/projectAccess.js';
import Project from '../models/Project.js';
import Source from '../models/Source.js';
import Finding from '../models/Finding.js';
import ReviewHistory from '../models/ReviewHistory.js';
import ProjectAssignment from '../models/ProjectAssignment.js';
import { canReviewFinding, claimReviewerAssignment } from '../services/projectAssignments.js';
import { appendAuditEvent } from '../services/auditEvents.js';
import { AnalysisJobError, advanceAnalysisJob, createOrGetAnalysisJob, getAnalysisJob, getProjectAnalysisJob, retryAnalysisJob } from '../services/analysisJobs.js';
import { assertCanReviewProject, ReviewWorkflowError, runReviewAction } from '../services/reviewWorkflow.js';
import { canEditProject, canReadProject } from '../services/projectPermissions.js';
import { claimProjectRoleWrite } from '../services/projectLifecycle.js';
import { logError } from '../utils/safeLogger.js';
import { canAccessAnalysisJob, publicAnalysisJob } from '../services/analysisJobState.js';

const router = Router();
router.use(requireAuth);
router.post('/projects/:id/analyze', requireProjectAccess, requireProjectEditor, async (req, res, next) => {
  try {
    const job = await createOrGetAnalysisJob({ projectId: req.project._id, actorId: req.user._id, sourceIds: req.body?.sourceIds });
    if (!job) return res.status(200).json({ job: null, alreadyAnalyzed: true, message: 'All processed sources have already been analyzed.' });
    return res.status(job.status === 'queued' && !job.startedAt ? 202 : 200).json({ job: publicAnalysisJob(job), message: 'Analysis job is saved. Advance it one source at a time while this workspace is open.' });
  } catch (error) {
    if (error instanceof AnalysisJobError) return res.status(error.status).json({ message: error.message });
    logError('analysis.job.create', error, { projectId: String(req.project._id) });
    return next(error);
  }
});

router.get('/projects/:id/analysis-job', requireProjectAccess, async (req, res, next) => {
  try { return res.json({ job: publicAnalysisJob(await getProjectAnalysisJob(req.project._id)) }); }
  catch (error) { return next(error); }
});

async function accessibleAnalysisJob(req, res, next) {
  try {
    if (!/^[a-f\d]{24}$/i.test(req.params.jobId || '')) return res.status(400).json({ message: 'Invalid analysis job ID.' });
    const job = await getAnalysisJob(req.params.jobId);
    if (!job) return res.status(404).json({ message: 'Analysis job not found.' });
    const project = await Project.findById(job.project);
    if (!project || !canAccessAnalysisJob(project, req.user._id, 'read')) return res.status(403).json({ message: 'You do not have access to this analysis job.' });
    if (project.deletionState && project.deletionState !== 'active') return res.status(410).json({ message: 'This project is in its deletion recovery lifecycle and is temporarily unavailable.' });
    req.analysisJob = job; req.project = project;
    return next();
  } catch (error) { return next(error); }
}

router.get('/analysis-jobs/:jobId', accessibleAnalysisJob, (req, res) => res.json({ job: publicAnalysisJob(req.analysisJob) }));
function requireAnalysisEditor(req, res, next) {
  if (!canAccessAnalysisJob(req.project, req.user._id, 'advance')) return res.status(403).json({ message: 'Only project owners and editors can advance analysis.' });
  return next();
}

router.post('/analysis-jobs/:jobId/advance', accessibleAnalysisJob, requireAnalysisEditor, async (req, res, next) => {
  try { return res.json({ job: publicAnalysisJob(await advanceAnalysisJob(req.analysisJob._id)) }); }
  catch (error) { if (error instanceof AnalysisJobError) return res.status(error.status).json({ message: error.message }); return next(error); }
});
router.post('/analysis-jobs/:jobId/retry', accessibleAnalysisJob, requireAnalysisEditor, async (req, res, next) => {
  try { return res.json({ job: publicAnalysisJob(await retryAnalysisJob(req.analysisJob._id)) }); }
  catch (error) { if (error instanceof AnalysisJobError) return res.status(error.status).json({ message: error.message }); return next(error); }
});

router.get('/projects/:id/findings', requireProjectAccess, async (req, res, next) => {
  try { return res.json({ findings: await Finding.find({ project: req.project._id }).populate('evidence.source', 'originalName') }); }
  catch (error) { return next(error); }
});

async function accessibleFinding(req, res, next) {
  try {
    if (!/^[a-f\d]{24}$/i.test(req.params.findingId || '')) return res.status(400).json({ message: 'Invalid finding ID.' });
    const finding = await Finding.findById(req.params.findingId);
    if (!finding) return res.status(404).json({ message: 'Finding not found' });
    const project = await Project.findById(finding.project);
    if (!project || !canReadProject(project, req.user._id)) return res.status(403).json({ message: 'Access denied' });
    if (project.deletionState && project.deletionState !== 'active') return res.status(410).json({ message: 'This project is in its deletion recovery lifecycle and is temporarily unavailable.' });
    req.finding = finding;
    req.project = project;
    return next();
  } catch (error) { return next(error); }
}

async function requireReviewer(req, res, next) {
  try {
    if (req.project.workflowPolicy?.reviewMode === 'assigned') {
      const finding = req.finding;
      const assignments = await ProjectAssignment.find({ project: req.project._id, user: req.user._id, role: 'reviewer', status: 'active' }).lean();
      if (!canReviewFinding(req.project, req.user._id, finding, assignments)) {
        return res.status(403).json({ message: 'An active reviewer assignment for this finding is required.' });
      }
      if (req.method === 'PATCH' && typeof req.body?.category === 'string' && req.body.category !== finding.category
        && !canReviewFinding(req.project, req.user._id, { category: req.body.category }, assignments)) {
        return res.status(403).json({ message: 'A reviewer assignment for the destination category is required to change this finding category.' });
      }
    } else assertCanReviewProject(req.project, req.user._id);
    return next();
  } catch (error) { return res.status(error.status || 403).json({ message: error.message }); }
}

async function withReviewTransaction(work, req) {
  await ReviewHistory.init();
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const currentProject = await claimProjectRoleWrite(req.project._id, req.user._id, 'member', session);
      result = await work({
        project: currentProject,
        findFinding: (findingId, projectId) => Finding.findOne({ _id: findingId, project: projectId }).session(session),
        saveFinding: (finding) => finding.save({ session }),
        appendHistory: (history) => ReviewHistory.create([history], { session }),
        claimReviewerAssignment: (finding) => claimReviewerAssignment({
          projectId: req.project._id, userId: req.user._id, category: finding.category, session,
        }),
        appendAuditEvent: ({ finding, projectId, actorId, change }) => appendAuditEvent({
          projectId,
          actorId,
          action: `finding.${change.history.action}`,
          targetType: 'finding',
          targetId: finding._id,
          scopeType: 'category',
          scopeValue: change.history.previousValues.category || finding.category,
          reason: change.history.reason,
          comment: change.history.comment,
          session,
        }),
      });
    });
    return result;
  } finally { await session.endSession(); }
}

async function performReviewAction(req, res, next, action) {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ message: 'Request body must be an object.' });
    const finding = await runReviewAction({
      findingId: req.finding._id,
      projectId: req.project._id,
      actorId: req.user._id,
      action,
      payload: req.body,
      transaction: (work) => withReviewTransaction(work, req),
      authorizeReview: async ({ finding, repository, action, payload }) => {
        const project = repository.project;
        if (project.workflowPolicy?.reviewMode === 'assigned') {
          const assignment = await repository.claimReviewerAssignment(finding);
          if (!assignment) throw new ReviewWorkflowError('An active reviewer assignment for this finding is required.', 403);
          if (action === 'edit' && typeof payload.category === 'string' && payload.category !== finding.category) {
            const targetAssignment = await repository.claimReviewerAssignment({ ...finding.toObject(), category: payload.category });
            if (!targetAssignment) throw new ReviewWorkflowError('A reviewer assignment for the destination category is required to change this finding category.', 403);
          }
        } else if (!canEditProject(project, req.user._id)) {
          throw new ReviewWorkflowError('Only current project owners and editors can change finding reviews.', 403);
        }
      },
    });
    return res.json({ finding });
  } catch (error) {
    if (error instanceof ReviewWorkflowError) return res.status(error.status).json({ message: error.message });
    if (error?.code === 'RETENTION_CONFIGURATION_INVALID') {
      return res.status(503).json({ message: 'Audit retention is not configured; the review was not saved.' });
    }
    return next(error);
  }
}

router.patch('/findings/:findingId', accessibleFinding, requireReviewer, (req, res, next) => performReviewAction(req, res, next, 'edit'));
router.post('/findings/:findingId/approve', accessibleFinding, requireReviewer, (req, res, next) => performReviewAction(req, res, next, 'approve'));
router.post('/findings/:findingId/reopen', accessibleFinding, requireReviewer, (req, res, next) => performReviewAction(req, res, next, 'reopen'));
router.post('/findings/:findingId/reject', accessibleFinding, requireReviewer, (req, res, next) => performReviewAction(req, res, next, 'reject'));
router.post('/findings/:findingId/clarify', accessibleFinding, requireReviewer, (req, res, next) => performReviewAction(req, res, next, 'clarify'));

router.get('/findings/:findingId/review-history', accessibleFinding, async (req, res, next) => {
  try {
    const history = await ReviewHistory.find({ finding: req.finding._id, project: req.project._id })
      .populate('reviewer', 'name email').sort({ createdAt: 1 }).lean();
    return res.json({ history });
  } catch (error) { return next(error); }
});

export default router;
