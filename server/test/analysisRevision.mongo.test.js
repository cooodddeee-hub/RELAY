import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import User from '../src/models/User.js';
import Project from '../src/models/Project.js';
import Source from '../src/models/Source.js';
import SourceRevision from '../src/models/SourceRevision.js';
import AnalysisJob from '../src/models/AnalysisJob.js';
import Finding from '../src/models/Finding.js';
import { createOrGetAnalysisJob, advanceAnalysisJob, retryAnalysisJob, ANALYSIS_SOURCE_TEXT_LIMIT } from '../src/services/analysisJobs.js';
import { verifyEvidenceQuote } from '../src/services/evidenceVerification.js';
import { extractFindings, GeminiAnalysisError } from '../src/services/gemini.js';

const testUri = process.env.RELAY_TEST_MONGODB_URI;
const localReplicaSetOnly = testUri ? { skip: false } : { skip: 'Set RELAY_TEST_MONGODB_URI to the isolated local MongoDB replica-set database.' };

async function connectSafe(uri) {
  let parsed;
  try { parsed = new URL(uri); } catch { throw new Error('RELAY_TEST_MONGODB_URI must be a valid local MongoDB URI.'); }
  if (parsed.protocol !== 'mongodb:' || parsed.hostname !== '127.0.0.1' || parsed.port !== '27018'
    || decodeURIComponent(parsed.pathname.replace(/^\//, '')) !== 'relay_round3_test'
    || parsed.searchParams.get('replicaSet') !== 'rs0') {
    throw new Error('Analysis revision integration tests only permit 127.0.0.1:27018/relay_round3_test with replicaSet=rs0.');
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 3000 });
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  assert.equal(hello.setName, 'rs0');
  assert.equal(hello.isWritablePrimary, true);
}

function makeRevision(source, revisionKey, textSnapshot) {
  return SourceRevision.create({
    source, revisionKey, contentHash: `hash-${revisionKey}`, textSnapshot,
    capturedAt: new Date(), locator: { provider: 'github', externalType: 'issue', issueNumber: 17, revisionKey },
  });
}

test('revision-pinned analysis uses immutable content and keeps legacy upload jobs compatible (isolated replica set only)', localReplicaSetOnly, async (t) => {
  await connectSafe(testUri);
  const projectIds = [];
  const sourceIds = [];
  const revisionIds = [];
  const jobIds = [];
  const findingIds = [];
  let userId;
  try {
    await Promise.all([User.init(), Project.init(), Source.init(), SourceRevision.init(), AnalysisJob.init(), Finding.init()]);
    const user = await User.create({ name: 'Phase 4D test', email: `phase4d-${new mongoose.Types.ObjectId()}@example.test`, passwordHash: 'test-only-hash' });
    userId = user._id;
    const project = await Project.create({ name: `Phase 4D ${new mongoose.Types.ObjectId()}`, owner: user._id });
    projectIds.push(project._id);

    const githubSource = await Source.create({
      project: project._id, provider: 'github', externalType: 'issue', repositoryLink: new mongoose.Types.ObjectId(),
      externalId: '17', originalName: 'Issue #17', mimeType: 'text/plain', size: 20,
      extractedText: 'Revision one exact text', status: 'processed', uploadedBy: user._id,
    });
    sourceIds.push(githubSource._id);
    const revision1 = await makeRevision(githubSource._id, 'revision-1', 'Revision one exact text');
    revisionIds.push(revision1._id);
    await Source.updateOne({ _id: githubSource._id }, { $set: { currentRevision: revision1._id } });

    await t.test('job pins revision 1, analyzes it after current pointer advances, and separately analyzes revision 2', async () => {
      const job1 = await createOrGetAnalysisJob({ projectId: project._id, actorId: user._id });
      jobIds.push(job1._id);
      assert.equal(job1.sourceRevisionSnapshots.length, 1);
      assert.equal(String(job1.sourceRevisionSnapshots[0].revision), String(revision1._id));
      assert.equal(job1.sourceRevisionSnapshots[0].revisionKey, revision1.revisionKey);

      const revision2 = await makeRevision(githubSource._id, 'revision-2', 'Revision two exact text');
      revisionIds.push(revision2._id);
      job1.sourceRevisionSnapshots[0].revision = revision2._id;
      await assert.rejects(job1.save(), /revision snapshots are immutable/);
      await assert.rejects(AnalysisJob.updateOne({ _id: job1._id }, {
        $set: { 'sourceRevisionSnapshots.0.revision': revision2._id },
      }), /revision snapshots are immutable/);
      const immutableJob1 = await AnalysisJob.findById(job1._id);
      assert.equal(String(immutableJob1.sourceRevisionSnapshots[0].revision), String(revision1._id));
      await Source.updateOne({ _id: githubSource._id }, { $set: { currentRevision: revision2._id, extractedText: revision2.textSnapshot } });
      let analyzedText;
      const completed1 = await advanceAnalysisJob(job1._id, { analyze: async (source) => {
        analyzedText = source.extractedText;
        const evidence = verifyEvidenceQuote({
          sourceId: source._id, sourceName: source.originalName, sourceText: source.extractedText,
          quote: 'Revision one exact text', sourceRevision: source._analysisRevisionId, locator: source._analysisRevisionLocator,
        });
        return [{ category: 'Decision', title: 'Revision decision', description: 'Decision from revision one.', evidence: [evidence] }];
      } });
      assert.equal(analyzedText, revision1.textSnapshot);
      assert.equal(completed1.status, 'completed');
      const stored1 = await Finding.findOne({ project: project._id, title: 'Revision decision' });
      findingIds.push(stored1._id);
      assert.equal(String(stored1.evidence[0].sourceRevision), String(revision1._id));
      assert.deepEqual(stored1.evidence[0].locator, revision1.locator);
      assert.equal(stored1.evidence[0].matchedText, 'Revision one exact text');
      let savedSource = await Source.findById(githubSource._id).select('+analyzedRevision +analysisCompletedAt');
      assert.equal(String(savedSource.analyzedRevision), String(revision1._id));

      const job2 = await createOrGetAnalysisJob({ projectId: project._id, actorId: user._id });
      jobIds.push(job2._id);
      assert.equal(String(job2.sourceRevisionSnapshots[0].revision), String(revision2._id));
      const completed2 = await advanceAnalysisJob(job2._id, { analyze: async (source) => [{
        category: 'Decision', title: 'Revision decision', description: 'Decision from revision two.',
        evidence: [verifyEvidenceQuote({ sourceId: source._id, sourceName: source.originalName, sourceText: source.extractedText,
          quote: 'Revision two exact text', sourceRevision: source._analysisRevisionId, locator: source._analysisRevisionLocator })],
      }] });
      assert.equal(completed2.status, 'completed');
      const findings = await Finding.find({ project: project._id, title: 'Revision decision' }).select('+analysisKey').sort({ createdAt: 1 });
      assert.equal(findings.length, 2);
      assert.notEqual(findings[0].analysisKey, findings[1].analysisKey);
      assert.deepEqual(findings.map((finding) => String(finding.evidence[0].sourceRevision)), [String(revision1._id), String(revision2._id)]);
      savedSource = await Source.findById(githubSource._id).select('+analyzedRevision');
      assert.equal(String(savedSource.analyzedRevision), String(revision2._id));
    });

    await t.test('retry keeps the original revision snapshot and failed analysis never advances the watermark', async () => {
      const revision3 = await makeRevision(githubSource._id, 'revision-3', 'Revision three exact text');
      revisionIds.push(revision3._id);
      await Source.updateOne({ _id: githubSource._id }, { $set: { currentRevision: revision3._id, extractedText: revision3.textSnapshot } });
      const job = await createOrGetAnalysisJob({ projectId: project._id, actorId: user._id });
      jobIds.push(job._id);
      assert.equal(String(job.sourceRevisionSnapshots[0].revision), String(revision3._id));
      const firstAttempt = await advanceAnalysisJob(job._id, { analyze: async () => {
        throw new GeminiAnalysisError('temporary', { status: 503, kind: 'provider', provider: 'gemini', providerStatus: 503, retryable: true });
      } });
      assert.equal(firstAttempt.status, 'retry_wait');

      const revision4 = await makeRevision(githubSource._id, 'revision-4', 'Revision four exact text');
      revisionIds.push(revision4._id);
      await Source.updateOne({ _id: githubSource._id }, { $set: { currentRevision: revision4._id, extractedText: revision4.textSnapshot } });
      await AnalysisJob.updateOne({ _id: job._id }, { $set: { retryAt: new Date(Date.now() - 1000) } });
      let retryText;
      const retried = await advanceAnalysisJob(job._id, { analyze: async (source) => {
        retryText = source.extractedText;
        return [{ category: 'Decision', title: 'Retry pinned revision', description: 'Retry from original revision.', evidence: [] }];
      } });
      assert.equal(retryText, revision3.textSnapshot);
      assert.equal(retried.status, 'completed');
      const savedSource = await Source.findById(githubSource._id).select('+analyzedRevision');
      assert.equal(String(savedSource.analyzedRevision), String(revision3._id));
      assert.notEqual(String(savedSource.analyzedRevision), String(revision4._id));

      const revision5 = await makeRevision(githubSource._id, 'revision-5', 'Revision five exact text');
      revisionIds.push(revision5._id);
      await Source.updateOne({ _id: githubSource._id }, { $set: { currentRevision: revision5._id, extractedText: revision5.textSnapshot } });
      const failedJob = await createOrGetAnalysisJob({ projectId: project._id, actorId: user._id });
      jobIds.push(failedJob._id);
      const failed = await advanceAnalysisJob(failedJob._id, { analyze: async () => { throw new Error('provider unavailable for test'); } });
      assert.equal(failed.status, 'failed');
      const afterFailure = await Source.findById(githubSource._id).select('+analyzedRevision');
      assert.equal(String(afterFailure.analyzedRevision), String(revision3._id));
    });

    await t.test('missing or mismatched pinned revision fails safely; legacy upload-only jobs remain compatible', async () => {
      const latestRevision = await Source.findById(githubSource._id).select('currentRevision');
      await Source.updateOne({ _id: githubSource._id }, { $set: { analyzedRevision: latestRevision.currentRevision } });
      await Project.updateOne({ _id: project._id }, { $unset: { activeAnalysisJob: 1 } });
      const brokenSource = await Source.create({
        project: project._id, provider: 'github', externalType: 'commit', repositoryLink: new mongoose.Types.ObjectId(),
        externalId: 'deadbeef', originalName: 'Commit deadbeef', mimeType: 'text/plain', size: 10,
        extractedText: 'mutable fallback must not be analyzed', status: 'processed', uploadedBy: user._id,
      });
      sourceIds.push(brokenSource._id);
      const missingRevision = await makeRevision(brokenSource._id, 'missing-revision', 'immutable');
      revisionIds.push(missingRevision._id);
      await Source.updateOne({ _id: brokenSource._id }, { $set: { currentRevision: missingRevision._id } });
      const brokenJob = await createOrGetAnalysisJob({ projectId: project._id, actorId: user._id });
      jobIds.push(brokenJob._id);
      await SourceRevision.deleteOne({ _id: missingRevision._id });
      let invoked = false;
      const missingResult = await advanceAnalysisJob(brokenJob._id, { analyze: async () => { invoked = true; return []; } });
      assert.equal(invoked, false);
      assert.equal(missingResult.status, 'failed');
      assert.equal(missingResult.lastErrorKind, 'revision_unavailable');
      assert.equal((await Source.findById(brokenSource._id).select('+analyzedRevision')).analyzedRevision, undefined);

      const mismatchedSource = await Source.create({
        project: project._id, provider: 'github', externalType: 'commit', repositoryLink: new mongoose.Types.ObjectId(),
        externalId: 'mismatch', originalName: 'Commit mismatch', mimeType: 'text/plain', size: 10,
        extractedText: 'must not analyze another source revision', status: 'processed', uploadedBy: user._id,
      });
      sourceIds.push(mismatchedSource._id);
      const mismatchedJob = await AnalysisJob.create({
        project: project._id, createdBy: user._id, sourceIds: [mismatchedSource._id],
        sourceRevisionSnapshots: [{ source: mismatchedSource._id, revision: revision1._id, revisionKey: revision1.revisionKey }],
        status: 'queued', stage: 'queued',
      });
      jobIds.push(mismatchedJob._id);
      const mismatchResult = await advanceAnalysisJob(mismatchedJob._id, { analyze: async () => assert.fail('mismatched revision must not reach analysis') });
      assert.equal(mismatchResult.status, 'failed');
      assert.equal(mismatchResult.lastErrorKind, 'revision_unavailable');

      const upload = await Source.create({
        project: project._id, provider: 'upload', originalName: 'uploaded.md', mimeType: 'text/markdown', size: 18,
        extractedText: 'Uploaded source text', status: 'processed', uploadedBy: user._id,
      });
      sourceIds.push(upload._id);
      const legacyJob = await AnalysisJob.create({ project: project._id, createdBy: user._id, sourceIds: [upload._id], status: 'queued', stage: 'queued' });
      jobIds.push(legacyJob._id);
      assert.equal(legacyJob.sourceRevisionSnapshots, undefined);
      let uploadedText;
      const legacyResult = await advanceAnalysisJob(legacyJob._id, { analyze: async (source) => {
        uploadedText = source.extractedText;
        return [{ category: 'Decision', title: 'Uploaded legacy result', description: 'Upload stays on the existing path.', evidence: [] }];
      } });
      assert.equal(legacyResult.status, 'completed');
      assert.equal(uploadedText, 'Uploaded source text');
    });

    await t.test('analysis and evidence verification share the existing 45,000-character limit', async () => {
      const text = `${'x'.repeat(ANALYSIS_SOURCE_TEXT_LIMIT)}\nquote outside the analysis window`;
      const longSource = await Source.create({
        project: project._id, provider: 'upload', originalName: 'long.txt', mimeType: 'text/plain', size: text.length,
        extractedText: text, status: 'processed', uploadedBy: user._id,
      });
      sourceIds.push(longSource._id);
      const longJob = await AnalysisJob.create({ project: project._id, createdBy: user._id, sourceIds: [longSource._id], status: 'queued', stage: 'queued' });
      jobIds.push(longJob._id);
      let seenLength;
      let evidenceStatus;
      await advanceAnalysisJob(longJob._id, { analyze: async (source) => {
        seenLength = source.extractedText.length;
        evidenceStatus = verifyEvidenceQuote({ sourceId: source._id, sourceName: source.originalName,
          sourceText: source.extractedText, quote: 'quote outside the analysis window' }).verificationStatus;
        return [];
      } });
      assert.equal(seenLength, ANALYSIS_SOURCE_TEXT_LIMIT);
      assert.equal(evidenceStatus, 'unverified');
    });

    await t.test('evidence mismatch retains seven completed sources and retry resumes only the failed eighth pinned source', async () => {
      const diagnosticProject = await Project.create({ name: `Phase 4D diagnostics ${new mongoose.Types.ObjectId()}`, owner: user._id });
      projectIds.push(diagnosticProject._id);
      const diagnosticRepository = new mongoose.Types.ObjectId();
      const diagnosticSources = [];
      for (let index = 0; index < 8; index += 1) {
        const text = `Private source ${index + 1}: exact approved passage ${index + 1}.`;
        const diagnosticSource = await Source.create({
          project: diagnosticProject._id, provider: 'github', externalType: 'commit', repositoryLink: diagnosticRepository,
          externalId: `diagnostic-commit-${index + 1}`, originalName: `Commit diagnostic-${index + 1}`,
          mimeType: 'text/plain', size: text.length, extractedText: text, status: 'processed', uploadedBy: user._id,
        });
        sourceIds.push(diagnosticSource._id);
        diagnosticSources.push(diagnosticSource);
        const revision = await makeRevision(diagnosticSource._id, `diagnostic-revision-${index + 1}`, text);
        revisionIds.push(revision._id);
        await Source.updateOne({ _id: diagnosticSource._id }, { $set: { currentRevision: revision._id } });
      }
      const job = await createOrGetAnalysisJob({
        projectId: diagnosticProject._id, actorId: user._id, sourceIds: diagnosticSources.map((item) => item._id),
      });
      jobIds.push(job._id);
      assert.equal(job.sourceRevisionSnapshots.length, 8);
      const failedSourceId = String(job.sourceIds[7]);
      const processedSourceIds = [];
      const analyzeWithValidationFailure = async (source, options) => {
        processedSourceIds.push(String(source._id));
        if (String(source._id) === failedSourceId) {
          return extractFindings(source, {
            ...options,
            cloudflareAccountId: 'integration-private-account', cloudflareApiToken: 'integration-private-token',
            cloudflareMaxRetries: 0,
            cloudflareFetch: async () => ({
              ok: true, status: 200,
              json: async () => ({ success: true, result: { response: JSON.stringify({ findings: [{
                category: 'Decision', title: 'Rejected case mismatch', description: 'This result must not be saved.',
                quote: 'EXACT approved passage 8.',
              }] }) } }),
            }),
          });
        }
        return [{ category: 'Decision', title: `Saved source ${source.originalName}`, description: 'Saved before later validation failure.', evidence: [] }];
      };

      let result;
      for (let index = 0; index < 8; index += 1) {
        result = await advanceAnalysisJob(job._id, { analyze: analyzeWithValidationFailure });
      }
      assert.equal(result.status, 'failed');
      assert.equal(result.completedSourceCount, 7);
      assert.equal(result.nextSourceIndex, 7);
      assert.equal(String(result.currentSource), failedSourceId);
      assert.deepEqual(processedSourceIds, job.sourceIds.slice(0, 8).map(String));
      const savedDiagnostic = result.lastValidationFailure.toObject();
      assert.deepEqual({ ...savedDiagnostic, sourceId: String(savedDiagnostic.sourceId), quoteMatchDiagnostics: { ...savedDiagnostic.quoteMatchDiagnostics } }, {
        provider: 'cloudflare', sourceType: 'commit', sourceId: failedSourceId,
        sourcePosition: 8, validationStage: 'evidence_verification', failureCode: 'evidence_quote_mismatch',
        quoteMatchDiagnostics: { exactQuoteMatch: false, caseOnlyMatch: true, punctuationOnlyMatch: false, unicodeNormalizationMatch: false },
      });
      const savedBeforeRetry = await Finding.find({ project: diagnosticProject._id });
      assert.equal(savedBeforeRetry.length, 7);
      assert.equal(savedBeforeRetry.some((finding) => finding.title === 'Recovered failed source'), false);

      const retriedJob = await retryAnalysisJob(job._id);
      assert.equal(retriedJob.status, 'queued');
      assert.equal(retriedJob.nextSourceIndex, 7);
      assert.equal(retriedJob.lastValidationFailure, undefined);
      const completed = await advanceAnalysisJob(job._id, { analyze: async (source, options) => {
        processedSourceIds.push(String(source._id));
        return extractFindings(source, {
          ...options,
          cloudflareAccountId: 'integration-private-account', cloudflareApiToken: 'integration-private-token',
          cloudflareMaxRetries: 0,
          cloudflareFetch: async () => ({ ok: true, status: 200, json: async () => ({
            success: true, result: { response: JSON.stringify({ findings: [{
              category: 'Decision', title: 'Recovered failed source', description: 'Retry result only.',
              quote: 'exact approved passage 8.',
            }] }) },
          }) }),
        });
      } });
      assert.equal(completed.status, 'completed');
      assert.deepEqual(processedSourceIds, [
        ...job.sourceIds.slice(0, 8).map(String), String(job.sourceIds[7]),
      ]);
      const savedAfterRetry = await Finding.find({ project: diagnosticProject._id });
      findingIds.push(...savedAfterRetry.map((finding) => finding._id));
      assert.equal(savedAfterRetry.length, 8);
      assert.equal(savedAfterRetry.filter((finding) => finding.title.startsWith('Saved source ')).length, 7);
      assert.equal(savedAfterRetry.filter((finding) => finding.title === 'Recovered failed source').length, 1);
      const recovered = savedAfterRetry.find((finding) => finding.title === 'Recovered failed source');
      assert.equal(recovered.evidence[0].verificationStatus, 'verified');
      assert.equal(String(recovered.evidence[0].sourceRevision), String(job.sourceRevisionSnapshots[7].revision));
    });

    await t.test('legacy GitHub analysis timestamp avoids reanalyzing its existing revision but admits a newer revision', async () => {
      const legacyProject = await Project.create({ name: `Phase 4D legacy ${new mongoose.Types.ObjectId()}`, owner: user._id });
      projectIds.push(legacyProject._id);
      const analyzedAt = new Date();
      const legacyGithub = await Source.create({
        project: legacyProject._id, provider: 'github', externalType: 'readme', repositoryLink: new mongoose.Types.ObjectId(),
        externalId: 'README.md', originalName: 'README.md', mimeType: 'text/markdown', size: 14,
        extractedText: 'legacy README', status: 'processed', uploadedBy: user._id, analysisCompletedAt: analyzedAt,
      });
      sourceIds.push(legacyGithub._id);
      const oldRevision = await SourceRevision.create({
        source: legacyGithub._id, revisionKey: 'legacy-readme-1', contentHash: 'legacy-hash-1', textSnapshot: 'legacy README',
        capturedAt: new Date(analyzedAt.getTime() - 1000), locator: { provider: 'github', path: 'README.md' },
      });
      revisionIds.push(oldRevision._id);
      await Source.updateOne({ _id: legacyGithub._id }, { $set: { currentRevision: oldRevision._id } });
      assert.equal(await createOrGetAnalysisJob({ projectId: legacyProject._id, actorId: user._id }), null);

      const newRevision = await SourceRevision.create({
        source: legacyGithub._id, revisionKey: 'legacy-readme-2', contentHash: 'legacy-hash-2', textSnapshot: 'new README',
        capturedAt: new Date(analyzedAt.getTime() + 1000), locator: { provider: 'github', path: 'README.md' },
      });
      revisionIds.push(newRevision._id);
      await Source.updateOne({ _id: legacyGithub._id }, { $set: { currentRevision: newRevision._id, extractedText: 'new README' } });
      const job = await createOrGetAnalysisJob({ projectId: legacyProject._id, actorId: user._id });
      assert.ok(job);
      jobIds.push(job._id);
      assert.equal(String(job.sourceRevisionSnapshots[0].revision), String(newRevision._id));
    });

    await t.test('explicit source selection pins only selected project sources and rejects cross-project IDs', async () => {
      const selectedProject = await Project.create({ name: `Phase 4D selected ${new mongoose.Types.ObjectId()}`, owner: user._id });
      projectIds.push(selectedProject._id);
      const selectedSource = await Source.create({
        project: selectedProject._id, provider: 'github', externalType: 'issue', repositoryLink: new mongoose.Types.ObjectId(),
        externalId: 'selected', originalName: 'Selected issue', mimeType: 'text/plain', size: 8,
        extractedText: 'selected', status: 'processed', uploadedBy: user._id,
      });
      const omittedSource = await Source.create({
        project: selectedProject._id, provider: 'upload', originalName: 'omitted.txt', mimeType: 'text/plain', size: 7,
        extractedText: 'omitted', status: 'processed', uploadedBy: user._id,
      });
      const selectedRevision = await makeRevision(selectedSource._id, 'selected-revision', 'selected');
      sourceIds.push(selectedSource._id, omittedSource._id);
      revisionIds.push(selectedRevision._id);
      await Source.updateOne({ _id: selectedSource._id }, { $set: { currentRevision: selectedRevision._id } });
      const job = await createOrGetAnalysisJob({ projectId: selectedProject._id, actorId: user._id, sourceIds: [selectedSource._id] });
      jobIds.push(job._id);
      assert.deepEqual(job.sourceIds.map(String), [String(selectedSource._id)]);
      assert.equal(job.sourceRevisionSnapshots.length, 1);
      await assert.rejects(createOrGetAnalysisJob({ projectId: selectedProject._id, actorId: user._id, sourceIds: [githubSource._id] }),
        (error) => error.status === 404);
    });
  } finally {
    if (findingIds.length) await Finding.deleteMany({ _id: { $in: findingIds } });
    if (jobIds.length) await AnalysisJob.deleteMany({ _id: { $in: jobIds } });
    if (sourceIds.length) await Source.deleteMany({ _id: { $in: sourceIds } });
    if (revisionIds.length) await SourceRevision.deleteMany({ _id: { $in: revisionIds } });
    if (projectIds.length) await Project.deleteMany({ _id: { $in: projectIds } });
    if (userId) await User.deleteOne({ _id: userId });
    await mongoose.disconnect();
  }
});
