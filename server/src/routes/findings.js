import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/auth.js';
import { requireProjectAccess, requireProjectEditor } from '../middleware/projectAccess.js';
import Project from '../models/Project.js';
import Source from '../models/Source.js';
import Finding from '../models/Finding.js';
import ReviewHistory from '../models/ReviewHistory.js';
import { AnalysisJobError, advanceAnalysisJob, createOrGetAnalysisJob, getAnalysisJob, getProjectAnalysisJob, retryAnalysisJob } from '../services/analysisJobs.js';
import { assertCanReviewProject, ReviewWorkflowError, runReviewAction } from '../services/reviewWorkflow.js';
import { canReadProject } from '../services/projectPermissions.js';
import { logError } from '../utils/safeLogger.js';
import { canAccessAnalysisJob, publicAnalysisJob } from '../services/analysisJobState.js';

const router = Router();
router.use(requireAuth);
router.post('/projects/:id/analyze', requireProjectAccess, requireProjectEditor, async (req, res, next) => {
  try {
    const job = await createOrGetAnalysisJob({ projectId: req.project._id, actorId: req.user._id });
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
    req.finding = finding;
    req.project = project;
    return next();
  } catch (error) { return next(error); }
}

function requireReviewer(req, res, next) {
  try { assertCanReviewProject(req.project, req.user._id); return next(); }
  catch (error) { return res.status(error.status || 403).json({ message: error.message }); }
}

async function withReviewTransaction(work) {
  await ReviewHistory.init();
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      result = await work({
        findFinding: (findingId, projectId) => Finding.findOne({ _id: findingId, project: projectId }).session(session),
        saveFinding: (finding) => finding.save({ session }),
        appendHistory: (history) => ReviewHistory.create([history], { session }),
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
      transaction: withReviewTransaction,
    });
    return res.json({ finding });
  } catch (error) {
    if (error instanceof ReviewWorkflowError) return res.status(error.status).json({ message: error.message });
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
