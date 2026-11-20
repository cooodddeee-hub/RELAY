import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/auth.js';
import { requireProjectAccess, requireProjectOwner } from '../middleware/projectAccess.js';
import GitHubInstallation from '../models/GitHubInstallation.js';
import GitHubInstallState from '../models/GitHubInstallState.js';
import ProjectRepository from '../models/ProjectRepository.js';
import GitHubSyncJob from '../models/GitHubSyncJob.js';
import Project from '../models/Project.js';
import User from '../models/User.js';
import { appendAuditEvent } from '../services/auditEvents.js';
import {
  createInstallState, getInstallation, getInstallationRepository, hashInstallState,
  installStateTtlMs, installationSetupUrl, listInstallationRepositories,
  oauthAuthorizationUrl, exchangeUserCode, listUserInstallations, verifyUserCanAccessInstallation, revokeUserAccessToken,
  readGitHubConfig, safeInstallationStatus, installationStatusSummary, GitHubApiError,
} from '../services/githubApp.js';
import {
  getGitHubSyncStatus,
  retryGitHubSync,
  startGitHubSync,
} from '../services/githubSync.js';

const router = Router();
const projectRouter = Router();
const idPattern = /^\d{1,24}$/;
const repoIdPattern = /^\d{1,24}$/;
const safeRepo = (repo) => ({
  repositoryId: String(repo.id), ownerLogin: repo.owner?.login, name: repo.name,
  fullName: repo.full_name, htmlUrl: repo.html_url, defaultBranch: repo.default_branch,
  private: Boolean(repo.private), archived: Boolean(repo.archived),
});
const syncStatusView = (job, now = new Date()) => {
  if (!job) return null;
  const interrupted = job.status === 'running' && (!job.leaseExpiresAt || job.leaseExpiresAt <= now);
  return {
    id: String(job._id), project: String(job.project), repositoryLink: String(job.repositoryLink),
    status: interrupted ? 'interrupted' : job.status, stage: job.stage,
    resultCompleteness: job.resultCompleteness || 'complete',
    retryable: interrupted || Boolean(job.retryable), retryAt: job.retryAt || undefined,
    lastErrorCode: job.lastErrorCode || undefined, checkpoints: job.checkpoints, counts: job.counts,
    attemptCount: job.attemptCount, startedAt: job.startedAt, deadlineAt: job.deadlineAt,
    completedAt: job.completedAt, lastProgressAt: job.lastProgressAt,
  };
};

async function inTransaction(operation) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await operation(session); });
    return result;
  } finally { await session.endSession(); }
}

async function reserveCurrentProjectOwner(session, projectId, actorId) {
  // The conditional write serializes a GitHub operation with ownership changes.
  // A read-only check would be vulnerable to MongoDB snapshot-isolation races.
  const result = await Project.updateOne(
    { _id: projectId, owner: actorId, $or: [{ deletionState: 'active' }, { deletionState: { $exists: false } }] },
    { $inc: { githubAuthorizationVersion: 1 } },
    { session, timestamps: false },
  );
  if (!result.matchedCount) throw Object.assign(new Error('Only the current project owner can manage GitHub integrations.'), { status: 403 });
}

function githubErrorResponse(error, res) {
  if (!(error instanceof GitHubApiError)) return false;
  if (error.code === 'GITHUB_RATE_LIMITED' && error.retryAfter) res.set('Retry-After', String(error.retryAfter));
  res.status(error.status).json({ code: error.code, message: 'GitHub request could not be completed.' });
  return true;
}

function githubFrontendReturnUrl(projectId, outcome) {
  const configured = String(process.env.CLIENT_URL || 'http://localhost:5173').split(',')[0].trim();
  let url;
  try { url = new URL(configured); } catch { return null; }
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if ((!local && url.protocol !== 'https:') || url.username || url.password) return null;
  url.search = '';
  url.hash = '';
  url.searchParams.set('github', outcome);
  url.searchParams.set('projectId', String(projectId));
  return url.toString();
}

function redirectGitHubResult(res, projectId, outcome) {
  const url = githubFrontendReturnUrl(projectId, outcome);
  if (!url) return res.status(500).json({ message: 'GitHub authorization could not return to the RELAY application.' });
  return res.redirect(302, url);
}

async function authorizedInstallation(installationId, userId) {
  if (!idPattern.test(String(installationId || ''))) return null;
  return GitHubInstallation.findOne({ installationId: String(installationId), authorizedUsers: userId, status: 'active' });
}

async function refreshInstallation(installation, { projectId, actorId }) {
  let nextStatus;
  let latest;
  try {
    latest = await getInstallation({ installationId: installation.installationId });
    nextStatus = safeInstallationStatus(latest);
  } catch (error) {
    if (error instanceof GitHubApiError && error.code === 'GITHUB_RESOURCE_UNAVAILABLE') {
      nextStatus = 'removed';
    } else {
      throw error;
    }
  }
  await inTransaction(async (session) => {
    await reserveCurrentProjectOwner(session, projectId, actorId);
    const current = await GitHubInstallation.findById(installation._id).select('status').session(session);
    if (!current) throw new GitHubApiError('GITHUB_RESOURCE_UNAVAILABLE', 404);
    const effectiveStatus = current.status === 'removed' ? 'removed' : nextStatus;
    await GitHubInstallation.updateOne({ _id: installation._id }, { $set: {
      status: effectiveStatus,
      ...(latest && effectiveStatus !== 'removed' ? {
        accountId: String(latest.account.id), accountLogin: latest.account.login,
        accountType: latest.account.type, grantedPermissions: latest.permissions || {},
      } : {}),
      lastVerifiedAt: new Date(),
    } }, { session });
    if (current.status !== effectiveStatus) await appendAuditEvent({
      projectId, actorId, action: `github.installation.${effectiveStatus}`,
      targetType: 'github_installation', targetId: installation._id, session,
    });
    nextStatus = effectiveStatus;
  });
  if (nextStatus === 'removed') throw new GitHubApiError('GITHUB_RESOURCE_UNAVAILABLE', 404);
  return nextStatus === 'active';
}

async function persistInstallationAuthorization({ project, actor, installation }) {
  const apply = () => inTransaction(async (session) => {
    await reserveCurrentProjectOwner(session, project._id, actor._id);
    const filter = { installationId: String(installation.id) };
    let record = await GitHubInstallation.findOne(filter).session(session);
    const alreadyAuthorized = Boolean(record && (record.authorizedUsers || []).some((id) => String(id) === String(actor._id)));
    const installationStatusChanged = Boolean(record && record.status !== 'active');
    const fields = {
      accountId: String(installation.account.id), accountLogin: installation.account.login,
      accountType: installation.account.type, status: 'active',
      grantedPermissions: installation.permissions || {}, lastVerifiedAt: new Date(),
    };
    if (record) {
      record = await GitHubInstallation.findOneAndUpdate(filter, { $set: fields, $addToSet: { authorizedUsers: actor._id } }, { new: true, session });
    } else {
      [record] = await GitHubInstallation.create([{
        ...fields, installationId: String(installation.id), installedBy: actor._id, authorizedUsers: [actor._id],
      }], { session });
    }
    if (!alreadyAuthorized || installationStatusChanged) await appendAuditEvent({
      projectId: project._id, actorId: actor._id,
      action: installationStatusChanged ? 'github.installation.reactivated' : 'github.installation.authorized',
      targetType: 'github_installation', targetId: record._id, session,
    });
    return record;
  });
  try { return await apply(); }
  catch (error) {
    if (error?.code !== 11000) throw error;
    // Another callback inserted this installation first. Re-read and add this
    // actor once; the authorization event is emitted only for a new user entry.
    return apply();
  }
}

router.get('/integrations/github/setup', async (req, res, next) => {
  try {
    const config = readGitHubConfig();
    if (!config) return res.status(503).json({ message: 'GitHub integration is not configured.' });
    const { installation_id: installationId, state, setup_action: setupAction } = req.query;
    if (!idPattern.test(String(installationId || '')) || typeof state !== 'string' || state.length < 32 || state.length > 200) {
      return res.status(400).json({ message: 'Invalid GitHub installation callback.' });
    }
    const installState = await GitHubInstallState.findOneAndUpdate(
      { stateHash: hashInstallState(state), purpose: 'setup', consumedAt: { $exists: false }, expiresAt: { $gt: new Date() } },
      { $set: { consumedAt: new Date() } },
      { new: true },
    );
    if (!installState) return res.status(400).json({ message: 'GitHub installation state is invalid, expired, or already used.' });
    const project = await Project.findById(installState.project).select('owner deletionState');
    const actor = await User.findById(installState.actor).select('_id');
    if (!project || !actor || String(project.owner) !== String(actor._id)) return res.status(403).json({ message: 'Only the current project owner can authorize this installation.' });
    if (project.deletionState && project.deletionState !== 'active') return res.status(410).json({ message: 'Project deletion has started.' });
    if (!['install', 'update'].includes(String(setupAction || 'install'))) return res.status(400).json({ message: 'Unsupported GitHub installation action.' });

    const installation = await getInstallation({ installationId, config });
    const status = safeInstallationStatus(installation);
    if (status !== 'active') return res.status(409).json({ message: 'This GitHub installation is suspended.' });
    const oauthState = createInstallState();
    await inTransaction(async (session) => {
      await reserveCurrentProjectOwner(session, project._id, actor._id);
      await GitHubInstallState.create([{
        stateHash: hashInstallState(oauthState), project: project._id, actor: actor._id,
        purpose: 'oauth', installationId: String(installation.id), expiresAt: new Date(Date.now() + installStateTtlMs),
      }], { session });
    });
    return res.redirect(302, oauthAuthorizationUrl(config, oauthState));
  } catch (error) {
    if (githubErrorResponse(error, res)) return;
    return next(error);
  }
});

router.get('/integrations/github/oauth/callback', async (req, res, next) => {
  let pending;
  try {
    const config = readGitHubConfig();
    if (!config) return res.status(503).json({ message: 'GitHub integration is not configured.' });
    const { code, state, error: oauthError } = req.query;
    if (typeof state !== 'string' || state.length < 32 || state.length > 200) return res.status(400).json({ message: 'Invalid GitHub authorization callback.' });
    pending = await GitHubInstallState.findOneAndUpdate(
      { stateHash: hashInstallState(state), purpose: { $in: ['oauth', 'oauth_discovery'] }, consumedAt: { $exists: false }, expiresAt: { $gt: new Date() } },
      { $set: { consumedAt: new Date() } }, { new: true },
    );
    if (!pending) return res.status(400).json({ message: 'GitHub authorization state is invalid, expired, or already used.' });
    const project = await Project.findById(pending.project).select('owner deletionState');
    const actor = await User.findById(pending.actor).select('_id');
    if (!project || !actor || String(project.owner) !== String(actor._id)) return res.status(403).json({ message: 'Only the current project owner can authorize this installation.' });
    if (project.deletionState && project.deletionState !== 'active') return redirectGitHubResult(res, pending.project, 'failed');
    if (oauthError) return redirectGitHubResult(res, pending.project, 'cancelled');
    if (typeof code !== 'string' || !code || code.length > 2000) return redirectGitHubResult(res, pending.project, 'failed');

    let accessToken;
    let candidateInstallationIds = [];
    let authorizationError;
    try {
      accessToken = await exchangeUserCode({ code, config });
      if (pending.installationId) {
        const userAccess = await verifyUserCanAccessInstallation({ accessToken, installationId: pending.installationId });
        if (!userAccess.authorized) authorizationError = Object.assign(new Error('Installation access denied.'), { status: 403 });
        else candidateInstallationIds = [pending.installationId];
      } else {
        const accessible = await listUserInstallations({ accessToken });
        candidateInstallationIds = accessible.installations.map((item) => item.id);
      }
    } catch (error) { authorizationError = error; }
    if (accessToken) {
      try { await revokeUserAccessToken({ accessToken, config }); }
      catch (error) { authorizationError = error; }
    }
    if (authorizationError) {
      return redirectGitHubResult(res, pending.project, 'failed');
    }
    const installations = [];
    for (const installationId of candidateInstallationIds) {
      try {
        const installation = await getInstallation({ installationId, config });
        if (String(installation.id) !== String(installationId)) continue;
        if (safeInstallationStatus(installation) === 'active') installations.push(installation);
      } catch (error) {
        // Discovery may include installations belonging to other GitHub Apps.
        if (!pending.installationId && error instanceof GitHubApiError && error.code === 'GITHUB_RESOURCE_UNAVAILABLE') continue;
        return redirectGitHubResult(res, pending.project, 'failed');
      }
    }
    if (!installations.length) return redirectGitHubResult(res, pending.project, 'no_installations');
    try {
      for (const installation of installations) await persistInstallationAuthorization({ project, actor, installation });
    } catch (error) {
      if (githubErrorResponse(error, res)) return;
      return redirectGitHubResult(res, pending.project, 'failed');
    }
    return redirectGitHubResult(res, pending.project, 'authorized');
  } catch (error) {
    if (pending?.project) return redirectGitHubResult(res, pending.project, 'failed');
    if (githubErrorResponse(error, res)) return;
    return next(error);
  }
});

projectRouter.use(requireAuth);
projectRouter.use('/:id/github', requireProjectAccess);

projectRouter.post('/:id/github/installations/start', requireProjectOwner, async (req, res, next) => {
  try {
    const config = readGitHubConfig();
    if (!config) return res.status(503).json({ message: 'GitHub integration is not configured.' });
    const state = createInstallState();
    await inTransaction(async (session) => {
      await reserveCurrentProjectOwner(session, req.project._id, req.user._id);
      await GitHubInstallState.create([{
        stateHash: hashInstallState(state), project: req.project._id, actor: req.user._id,
        expiresAt: new Date(Date.now() + installStateTtlMs),
      }], { session });
    });
    return res.status(201).json({ installationUrl: installationSetupUrl(config.slug, state) });
  } catch (error) { return next(error); }
});

projectRouter.post('/:id/github/installations/authorize', requireProjectOwner, async (req, res, next) => {
  try {
    const config = readGitHubConfig();
    if (!config) return res.status(503).json({ message: 'GitHub integration is not configured.' });
    const state = createInstallState();
    await inTransaction(async (session) => {
      await reserveCurrentProjectOwner(session, req.project._id, req.user._id);
      await GitHubInstallState.create([{
        stateHash: hashInstallState(state), project: req.project._id, actor: req.user._id,
        purpose: 'oauth_discovery', expiresAt: new Date(Date.now() + installStateTtlMs),
      }], { session });
    });
    return res.status(201).json({ authorizationUrl: oauthAuthorizationUrl(config, state) });
  } catch (error) { return next(error); }
});

projectRouter.get('/:id/github/installations', requireProjectOwner, async (req, res, next) => {
  try {
    const installations = await GitHubInstallation.find({ authorizedUsers: req.user._id }).select('installationId accountLogin accountType status grantedPermissions lastVerifiedAt');
    return res.json({ installations: installations.map((item) => ({ id: item.installationId, accountLogin: item.accountLogin, accountType: item.accountType, permissions: item.grantedPermissions, ...installationStatusSummary(item) })) });
  } catch (error) { return next(error); }
});

projectRouter.get('/:id/github/repositories', async (req, res, next) => {
  try {
    if (req.query.installationId) {
      if (String(req.project.owner) !== String(req.user._id)) return res.status(403).json({ message: 'Only the project owner can discover GitHub repositories.' });
      const installation = await authorizedInstallation(req.query.installationId, req.user._id);
      if (!installation) return res.status(404).json({ message: 'Authorized active installation not found.' });
      if (!await refreshInstallation(installation, { projectId: req.project._id, actorId: req.user._id })) return res.status(409).json({ message: 'This GitHub installation is suspended.' });
      const page = Number(req.query.page || 1);
      if (!Number.isInteger(page) || page < 1 || page > 10) return res.status(400).json({ message: 'Page must be between 1 and 10.' });
      const repositories = await listInstallationRepositories({ installationId: installation.installationId, page });
      return res.json({ repositories: repositories.map(safeRepo) });
    }
    const linked = await ProjectRepository.find({ project: req.project._id }).sort({ createdAt: -1 }).limit(100).lean();
    if (!linked.length) return res.json({ repositories: [] });
    const linkIds = linked.map((item) => item._id);
    const installationIds = [...new Set(linked.map((item) => String(item.installation)))];
    const [installations, jobs] = await Promise.all([
      GitHubInstallation.find({ _id: { $in: installationIds } }).select('accountLogin status lastVerifiedAt').lean(),
      GitHubSyncJob.aggregate([
        { $match: { project: req.project._id, repositoryLink: { $in: linkIds } } },
        { $sort: { createdAt: -1 } },
        { $group: { _id: '$repositoryLink', job: { $first: '$$ROOT' } } },
        { $replaceRoot: { newRoot: '$job' } },
        { $project: { _id: 1, project: 1, repositoryLink: 1, status: 1, stage: 1, resultCompleteness: 1,
          retryable: 1, retryAt: 1, lastErrorCode: 1, checkpoints: 1, counts: 1, attemptCount: 1,
          startedAt: 1, deadlineAt: 1, completedAt: 1, lastProgressAt: 1, createdAt: 1, leaseExpiresAt: 1 } },
      ]),
    ]);
    const installationsById = new Map(installations.map((item) => [String(item._id), item]));
    const latestJobs = new Map();
    for (const job of jobs) if (!latestJobs.has(String(job.repositoryLink))) latestJobs.set(String(job.repositoryLink), job);
    const now = new Date();
    const repositories = linked.map((item) => {
      const installation = installationsById.get(String(item.installation));
      const installationStatus = installation?.status || 'removed';
      const needsVerification = installationStatus === 'active'
        && (!installation?.lastVerifiedAt || now.getTime() - installation.lastVerifiedAt.getTime() > 5 * 60 * 1000);
      return {
        id: String(item._id), repositoryId: item.repositoryId, ownerLogin: item.ownerLogin,
        name: item.name, fullName: item.fullName, htmlUrl: item.htmlUrl, defaultBranch: item.defaultBranch,
        status: item.status || 'active', linkedAt: item.createdAt, unlinkedAt: item.unlinkedAt || undefined,
        installation: { accountLogin: installation?.accountLogin || '', status: installationStatus, lastVerifiedAt: installation?.lastVerifiedAt || undefined, needsVerification },
        connectionStatus: (item.status || 'active') === 'unlinked' ? 'unlinked'
          : installationStatus !== 'active' ? 'needs_reauthorization'
            : needsVerification ? 'needs_verification' : 'active',
        latestSyncJob: syncStatusView(latestJobs.get(String(item._id)), now),
      };
    });
    return res.json({ repositories, hasMore: linked.length === 100 });
  } catch (error) {
    if (githubErrorResponse(error, res)) return;
    return next(error);
  }
});

projectRouter.post('/:id/github/repositories', requireProjectOwner, async (req, res, next) => {
  try {
    const { installationId, repositoryId } = req.body || {};
    if (!idPattern.test(String(installationId || '')) || !repoIdPattern.test(String(repositoryId || ''))) return res.status(400).json({ message: 'A valid installationId and repositoryId are required.' });
    const installation = await authorizedInstallation(installationId, req.user._id);
    if (!installation) return res.status(404).json({ message: 'Authorized active installation not found.' });
    if (!await refreshInstallation(installation, { projectId: req.project._id, actorId: req.user._id })) return res.status(409).json({ message: 'This GitHub installation is suspended.' });
    const githubRepository = await getInstallationRepository({ installationId: installation.installationId, repositoryId });
    if (String(githubRepository.id) !== String(repositoryId) || !githubRepository.owner?.login || !githubRepository.name || !githubRepository.html_url) {
      return res.status(404).json({ message: 'Repository is not available to this GitHub installation.' });
    }
    const repo = safeRepo(githubRepository);
    const linked = await inTransaction(async (session) => {
      await reserveCurrentProjectOwner(session, req.project._id, req.user._id);
      const [saved] = await ProjectRepository.create([{
        project: req.project._id, installation: installation._id, repositoryId: repo.repositoryId,
        ownerLogin: repo.ownerLogin, name: repo.name, fullName: repo.fullName,
        htmlUrl: repo.htmlUrl, defaultBranch: repo.defaultBranch, linkedBy: req.user._id,
      }], { session });
      await appendAuditEvent({
        projectId: req.project._id, actorId: req.user._id, action: 'github.repository.linked',
        targetType: 'project_repository', targetId: saved._id,
        githubRepository: { repositoryId: saved.repositoryId, fullName: saved.fullName }, session,
      });
      return saved;
    });
    return res.status(201).json({ repository: { id: String(linked._id), repositoryId: linked.repositoryId, ownerLogin: linked.ownerLogin, name: linked.name, fullName: linked.fullName, htmlUrl: linked.htmlUrl, defaultBranch: linked.defaultBranch } });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ message: 'This repository is already linked to the project.' });
    if (githubErrorResponse(error, res)) return;
    return next(error);
  }
});

projectRouter.delete('/:id/github/repositories/:linkId', requireProjectOwner, async (req, res, next) => {
  try {
    const linked = await inTransaction(async (session) => {
      await reserveCurrentProjectOwner(session, req.project._id, req.user._id);
      const unlinked = await ProjectRepository.findOneAndUpdate(
        { _id: req.params.linkId, project: req.project._id, status: 'active' },
        { $set: { status: 'unlinked', unlinkedAt: new Date(), unlinkedBy: req.user._id } },
        { new: true, session },
      );
      if (unlinked) await appendAuditEvent({
        projectId: req.project._id, actorId: req.user._id, action: 'github.repository.unlinked',
        targetType: 'project_repository', targetId: unlinked._id,
        githubRepository: { repositoryId: unlinked.repositoryId, fullName: unlinked.fullName }, session,
      });
      return unlinked;
    });
    if (!linked) return res.status(404).json({ message: 'Active linked repository not found.' });
    return res.json({ message: 'Repository unlinked. Its identity and the shared GitHub App installation are retained.' });
  } catch (error) { return next(error); }
});

projectRouter.post('/:id/github/repositories/:linkId/sync', requireProjectOwner, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.linkId)) return res.status(400).json({ code: 'INVALID_SYNC_REQUEST', message: 'A valid linked repository ID is required.' });
    const result = await startGitHubSync({ projectId: req.project._id, linkId: req.params.linkId, actorId: req.user._id });
    const status = result.status.status === 'running' ? 202 : (result.created ? 201 : 200);
    return res.status(status).json({ job: result.status });
  } catch (error) {
    if (error?.status && error?.code) return res.status(error.status).json({ code: error.code, message: 'GitHub synchronization could not be started.' });
    return next(error);
  }
});

projectRouter.get('/:id/github/sync-jobs/:jobId', async (req, res, next) => {
  try {
    const status = await getGitHubSyncStatus({ projectId: req.project._id, jobId: req.params.jobId });
    return res.json({ job: status });
  } catch (error) {
    if (error?.status && error?.code) return res.status(error.status).json({ code: error.code, message: 'GitHub sync status is unavailable.' });
    return next(error);
  }
});

projectRouter.post('/:id/github/sync-jobs/:jobId/retry', requireProjectOwner, async (req, res, next) => {
  try {
    const result = await retryGitHubSync({ projectId: req.project._id, jobId: req.params.jobId, actorId: req.user._id });
    return res.status(result.status.status === 'running' ? 202 : 200).json({ job: result.status });
  } catch (error) {
    if (error?.status && error?.code) return res.status(error.status).json({ code: error.code, message: 'GitHub sync retry could not be started.' });
    return next(error);
  }
});

router.use('/projects', projectRouter);
export default router;
