import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { requireAuth } from '../middleware/auth.js';
import { requireProjectAccess, requireProjectEditor } from '../middleware/projectAccess.js';
import Finding from '../models/Finding.js';
import Handover from '../models/Handover.js';
import Project from '../models/Project.js';
import { canReadProject } from '../services/projectPermissions.js';
import { acquireHandoverLock, createHandoverSnapshot, nextHandoverVersion, renderHandoverPdf } from '../services/handoverReport.js';

const router = Router();
router.use(requireAuth);
const validId = (id) => /^[a-f\d]{24}$/i.test(id || '');
const LOCK_MS = 2 * 60 * 1000;
const selectedHandoverFields = 'project version reportContent findingIds approvalStatus createdBy createdAt updatedAt';

router.post('/projects/:id/handover', requireProjectAccess, requireProjectEditor, async (req, res, next) => {
  const projectId = req.project._id;
  const lockToken = randomUUID();
  let locked = false;
  try {
    locked = await acquireHandoverLock(Project, projectId, lockToken, new Date(), LOCK_MS);
    if (!locked) {
      return res.status(409).json({ message: 'A handover version is already being generated for this project. Please wait and retry.' });
    }

    const approvedFindings = await Finding.find({ project: projectId, status: 'approved' })
      .populate('evidence.source', 'originalName').sort({ createdAt: 1, _id: 1 }).lean();
    const latest = await Handover.findOne({ project: projectId }).sort({ version: -1 }).select('version').lean();
    const version = nextHandoverVersion(latest?.version);
    const reportContent = createHandoverSnapshot({ project: req.project, approvedFindings, version, generatedBy: req.user });
    const handover = await Handover.create({
      project: projectId,
      version,
      reportContent,
      findingIds: approvedFindings.map((finding) => finding._id),
      createdBy: req.user._id,
      approvalStatus: 'draft',
    });
    return res.status(201).json({ handover });
  } catch (error) { return next(error); }
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
    return res.json({ handovers });
  } catch (error) { return next(error); }
});

async function accessibleHandover(req, res, next) {
  try {
    if (!validId(req.params.handoverId)) return res.status(400).json({ message: 'Invalid handover ID.' });
    const handover = await Handover.findById(req.params.handoverId).select(selectedHandoverFields).populate('createdBy', 'name email').lean();
    if (!handover) return res.status(404).json({ message: 'Handover not found.' });
    const project = await Project.findById(handover.project);
    if (!project || !canReadProject(project, req.user._id)) return res.status(403).json({ message: 'You do not have access to this handover.' });
    req.handover = handover;
    return next();
  } catch (error) { return next(error); }
}

router.get('/handovers/:handoverId', accessibleHandover, (req, res) => res.json({ handover: req.handover }));

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
