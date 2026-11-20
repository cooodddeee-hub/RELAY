import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { processProjectDeletionBatch } from '../services/projectDeletion.js';

const router = Router();

router.get('/project-deletions/process', async (req, res, next) => {
  try {
    const expected = String(process.env.CRON_SECRET || '');
    if (!expected) return res.status(503).json({ message: 'Project deletion processor is not configured.' });
    const supplied = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const expectedDigest = createHash('sha256').update(expected).digest();
    const suppliedDigest = createHash('sha256').update(supplied).digest();
    const valid = timingSafeEqual(expectedDigest, suppliedDigest) && supplied.length === expected.length;
    if (!valid) return res.status(401).json({ message: 'Processor authorization failed.' });
    let processedProjects = 0;
    const results = [];
    const startedAt = Date.now();
    // Keep one Vercel invocation bounded; each underlying call processes at
    // most one project and one 20-record batch before returning.
    for (let batch = 0; batch < 10 && Date.now() - startedAt < 240_000; batch += 1) {
      const result = await processProjectDeletionBatch({ batchSize: 1 });
      processedProjects += result.processedProjects;
      results.push(...result.results);
      if (!result.processedProjects) break;
    }
    return res.json({ processedProjects, batches: results.length, results });
  } catch (error) { return next(error); }
});

export default router;
