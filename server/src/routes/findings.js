import { Router } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/auth.js';
import { requireProjectAccess, requireProjectEditor } from '../middleware/projectAccess.js';
import Project from '../models/Project.js';
import Source from '../models/Source.js';
import Finding from '../models/Finding.js';
import ReviewHistory from '../models/ReviewHistory.js';
import { extractFindings } from '../services/gemini.js';
import { assertCanReviewProject, ReviewWorkflowError, runReviewAction } from '../services/reviewWorkflow.js';
import { canReadProject } from '../services/projectPermissions.js';
import { logError } from '../utils/safeLogger.js';

const router = Router();
router.use(requireAuth);
const LOCK_MS = 10 * 60 * 1000;
const SOURCE_CONCURRENCY = 2;

function analysisKey(projectId, sourceId, title) {
  const normalizedTitle = String(title).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  return createHash('sha256').update(`${projectId}:${sourceId}:${normalizedTitle}`).digest('hex');
}

async function saveSourceAnalysisOnce(projectId, source, items) {
  const session = await mongoose.startSession();
  let savedFindings = [];
  try {
    await session.withTransaction(async () => {
      const currentSource = await Source.findById(source._id).select('analysisCompletedAt').session(session);
      if (!currentSource || currentSource.analysisCompletedAt) { savedFindings = []; return; }

      const saved = [];
      for (const item of items) {
        const key = analysisKey(projectId, source._id, item.title);
        const legacy = await Finding.findOne({ project: projectId, 'evidence.source': source._id, title: item.title }).session(session);
        if (legacy) {
          if (!legacy.analysisKey) {
            legacy.analysisKey = key;
            try { await legacy.save({ session }); }
            catch (error) { if (error?.code !== 11000) throw error; }
          }
          saved.push(legacy);
          continue;
        }
        saved.push(await Finding.findOneAndUpdate(
          { analysisKey: key },
          { $setOnInsert: { project: projectId, analysisKey: key, ...item, status: 'pending' } },
          { upsert: true, new: true, setDefaultsOnInsert: true, session },
        ));
      }
      await Source.updateOne({ _id: source._id, project: projectId }, { $set: { analysisCompletedAt: new Date() } }, { session });
      savedFindings = saved;
    });
    return savedFindings;
  } finally {
    await session.endSession();
  }
}

router.post('/projects/:id/analyze', requireProjectAccess, requireProjectEditor, async (req, res, next) => {
  const projectId = req.project._id;
  const projectIdText = String(projectId);
  const lockToken = randomUUID();
  const startedAt = Date.now();
  let locked = false;

  try {
    const lock = await Project.updateOne(
      { _id: projectId, $or: [{ analysisLockExpiresAt: { $exists: false } }, { analysisLockExpiresAt: { $lte: new Date() } }] },
      { $set: { analysisLockToken: lockToken, analysisLockExpiresAt: new Date(Date.now() + LOCK_MS) } },
    );
    if (lock.modifiedCount !== 1) return res.status(409).json({ message: 'Analysis is already running for this project. Wait for it to finish before retrying.' });
    locked = true;

    const processedSources = await Source.find({ project: projectId, status: 'processed' }).select('+analysisCompletedAt').sort({ createdAt: 1 });
    if (!processedSources.length) return res.status(400).json({ message: 'Upload and process at least one document first.' });
    const sources = processedSources.filter((source) => !source.analysisCompletedAt);
    if (!sources.length) {
      const findings = await Finding.find({ project: projectId }).populate('evidence.source', 'originalName');
      return res.json({ findings, message: 'All processed sources have already been analyzed.' });
    }

    const analyzed = [];
    for (let offset = 0; offset < sources.length; offset += SOURCE_CONCURRENCY) {
      const renewedLock = await Project.updateOne(
        { _id: projectId, analysisLockToken: lockToken },
        { $set: { analysisLockExpiresAt: new Date(Date.now() + LOCK_MS) } },
      );
      if (renewedLock.modifiedCount !== 1) {
        const lockError = new Error('Analysis lock expired before the next batch.');
        lockError.status = 409;
        throw lockError;
      }
      const batch = sources.slice(offset, offset + SOURCE_CONCURRENCY);
      const results = await Promise.allSettled(batch.map(async (source) => {
        const items = await extractFindings(source);
        return saveSourceAnalysisOnce(projectId, source, items);
      }));
      for (const result of results) if (result.status === 'fulfilled') analyzed.push(...result.value);
      const failure = results.find((result) => result.status === 'rejected');
      if (failure) throw failure.reason;
    }

    console.info(JSON.stringify({ level: 'info', operation: 'analysis.completed', projectId: projectIdText, sourceCount: sources.length, findingCount: analyzed.length, durationMs: Date.now() - startedAt }));
    return res.json({ findings: analyzed, message: 'AI findings created; human review is required' });
  } catch (error) {
    logError('analysis.project', error, { projectId: projectIdText, durationMs: Date.now() - startedAt });
    if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 600) {
      if (error.status === 429 || error.status === 503) res.set('Retry-After', '2');
      const message = error.status === 429
        ? 'Gemini rate limit reached. Wait briefly and retry; uploaded sources remain saved and repeated findings are deduplicated.'
        : error.status === 503
          ? 'Gemini is temporarily unavailable. Retry shortly; uploaded sources remain saved and repeated findings are deduplicated.'
          : error.status === 504
            ? 'Gemini analysis timed out. Retry shortly; uploaded sources remain saved and repeated findings are deduplicated.'
            : error.status === 502
              ? 'Gemini returned an unusable analysis response. No unsupported findings were added for that response; retry after checking server logs.'
              : 'Analysis could not be completed. Uploaded sources remain saved; retry is safe.';
      return res.status(error.status).json({ message });
    }
    return res.status(500).json({ message: 'Analysis failed because of a server error. Uploaded sources remain saved; retry is safe.' });
  } finally {
    if (locked) {
      try { await Project.updateOne({ _id: projectId, analysisLockToken: lockToken }, { $unset: { analysisLockToken: 1, analysisLockExpiresAt: 1 } }); }
      catch (error) { logError('analysis.releaseLock', error, { projectId: projectIdText }); }
    }
  }
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
