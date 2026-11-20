import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import Project from '../models/Project.js';
import ProjectRepository from '../models/ProjectRepository.js';
import GitHubInstallation from '../models/GitHubInstallation.js';
import GitHubSyncJob, { GITHUB_SYNC_DEADLINE_MS, GITHUB_SYNC_LEASE_GRACE_MS } from '../models/GitHubSyncJob.js';
import Source from '../models/Source.js';
import SourceRevision from '../models/SourceRevision.js';
import { appendAuditEvent } from './auditEvents.js';
import {
  GitHubApiError,
  getInstallation,
  getInstallationRepository,
  getRecentRepositoryCommits,
  getRepositoryReadme,
  listRecentRepositoryIssues,
  safeInstallationStatus,
} from './githubApp.js';
import { createGitHubContentBudget, GITHUB_CONTENT_LIMITS } from './githubContent.js';

const PROVIDER_TIMEOUT_MS = 10_000;
const PERSISTENCE_RESERVE_MS = 5_000;
const LEASE_GRACE_MS = GITHUB_SYNC_LEASE_GRACE_MS;
const COMMIT_BATCH_SIZE = 10;
const INSTALLATION_STATUS_FRESH_MS = 5 * 60 * 1000;
const validId = (value) => mongoose.isValidObjectId(value);

export class GitHubSyncError extends Error {
  constructor(code, status = 409, { retryable = false, retryAt } = {}) {
    super(code);
    this.name = 'GitHubSyncError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.retryAt = retryAt;
  }
}

function transaction(operation) {
  return mongoose.startSession().then(async (session) => {
    try {
      let result;
      await session.withTransaction(async () => { result = await operation(session); });
      return result;
    } finally { await session.endSession(); }
  });
}

async function reserveOwner(session, projectId, actorId) {
  const result = await Project.updateOne(
    { _id: projectId, owner: actorId, $or: [{ deletionState: 'active' }, { deletionState: { $exists: false } }] },
    { $inc: { githubAuthorizationVersion: 1 } },
    { session, timestamps: false },
  );
  if (!result.matchedCount) throw new GitHubSyncError('PROJECT_OWNER_CHANGED', 403);
}

function classifyFailure(error) {
  if (error instanceof GitHubSyncError) return error;
  if (error instanceof GitHubApiError) {
    const retryable = [
      'GITHUB_TIMEOUT', 'GITHUB_UNAVAILABLE', 'GITHUB_PROVIDER_ERROR',
      'GITHUB_RATE_LIMITED', 'GITHUB_AUTH_EXPIRED',
    ].includes(error.code);
    const retryAt = error.retryAfter
      ? new Date(Date.now() + Number(error.retryAfter) * 1000)
      : (retryable ? new Date(Date.now() + 1000) : undefined);
    return new GitHubSyncError(error.code, error.status, { retryable, retryAt });
  }
  if (error instanceof mongoose.Error.ValidationError || error instanceof mongoose.Error.CastError) {
    return new GitHubSyncError('GITHUB_SYNC_MODEL_INVALID', 500);
  }
  if (error instanceof mongoose.Error) {
    return new GitHubSyncError('GITHUB_SYNC_DATABASE_ERROR', 503, { retryable: true, retryAt: new Date(Date.now() + 1000) });
  }
  if (error instanceof TypeError) return new GitHubSyncError('GITHUB_SYNC_TYPE_ERROR', 500);
  if (error instanceof ReferenceError) return new GitHubSyncError('GITHUB_SYNC_INTERNAL_ERROR', 500);
  return new GitHubSyncError('GITHUB_SYNC_FAILED', 502, { retryable: true, retryAt: new Date(Date.now() + 1000) });
}

function ensureTimeForProvider(deadlineAt) {
  const remaining = new Date(deadlineAt).getTime() - Date.now() - PERSISTENCE_RESERVE_MS;
  if (!Number.isFinite(remaining) || remaining <= 0) throw new GitHubSyncError('GITHUB_SYNC_DEADLINE', 504, { retryable: true, retryAt: new Date() });
  return Math.min(PROVIDER_TIMEOUT_MS, remaining);
}

async function authorizeProviderCall(jobId, leaseToken, { allowStaleInstallation = false } = {}) {
  const job = await loadJobLease(jobId, leaseToken);
  await transaction(async (session) => getAuthorizedScope(session, {
    projectId: job.project,
    actorId: job.requestedBy,
    linkId: job.repositoryLink,
    jobId,
    leaseToken,
    allowStaleInstallation,
  }));
  return ensureTimeForProvider((await loadJobLease(jobId, leaseToken)).deadlineAt);
}

function getSyncDocument(jobId, session, { privateFields = false } = {}) {
  let query = GitHubSyncJob.findById(jobId);
  if (privateFields) query = query.select('+leaseToken +leaseExpiresAt');
  return query.session(session);
}

async function getAuthorizedScope(session, { projectId, actorId, linkId, jobId, leaseToken, enforceDeadline = true, allowStaleInstallation = false }) {
  await reserveOwner(session, projectId, actorId);
  const link = await ProjectRepository.findOne({ _id: linkId, project: projectId, status: 'active' }).session(session);
  if (!link) throw new GitHubSyncError('GITHUB_REPOSITORY_UNLINKED', 409);
  const installation = await GitHubInstallation.findOne({
    _id: link.installation,
    status: 'active',
    authorizedUsers: actorId,
  }).session(session);
  if (!installation) throw new GitHubSyncError('GITHUB_INSTALLATION_UNAVAILABLE', 409);
  if (!allowStaleInstallation && (!installation.lastVerifiedAt || Date.now() - installation.lastVerifiedAt.getTime() > INSTALLATION_STATUS_FRESH_MS)) {
    throw new GitHubSyncError('GITHUB_INSTALLATION_STATUS_STALE', 409, { retryable: true, retryAt: new Date() });
  }

  const job = await getSyncDocument(jobId, session, { privateFields: true });
  const now = Date.now();
  if (!job || String(job.project) !== String(projectId) || String(job.repositoryLink) !== String(linkId)
    || String(job.installation) !== String(installation._id)
    || job.status !== 'running' || !job.active || job.leaseToken !== leaseToken
    || !job.leaseExpiresAt || job.leaseExpiresAt.getTime() <= now
    || (enforceDeadline && job.deadlineAt.getTime() <= now)) {
    throw new GitHubSyncError('GITHUB_SYNC_LEASE_LOST', 409);
  }
  return { link, installation, job };
}

async function assertOwnerAndActiveLink(session, { projectId, actorId, linkId, installationId }) {
  await reserveOwner(session, projectId, actorId);
  const link = await ProjectRepository.findOne({ _id: linkId, project: projectId, installation: installationId, status: 'active' }).session(session);
  if (!link) throw new GitHubSyncError('GITHUB_REPOSITORY_UNLINKED', 409);
  const installation = await GitHubInstallation.findOne({ _id: installationId, status: 'active', authorizedUsers: actorId }).session(session);
  if (!installation) throw new GitHubSyncError('GITHUB_INSTALLATION_UNAVAILABLE', 409);
  return { link, installation };
}

function makeJobFields({ projectId, link, actorId, now, leaseToken }) {
  const deadlineAt = new Date(now.getTime() + GITHUB_SYNC_DEADLINE_MS);
  return {
    project: projectId,
    repositoryLink: link._id,
    installation: link.installation,
    requestedBy: actorId,
    status: 'running',
    active: true,
    retryable: false,
    attemptCount: 1,
    startedAt: now,
    deadlineAt,
    leaseToken,
    leaseExpiresAt: new Date(deadlineAt.getTime() + LEASE_GRACE_MS),
    lastProgressAt: now,
  };
}

export async function claimGitHubSync({ projectId, linkId, actorId }) {
  if (![projectId, linkId, actorId].every(validId)) throw new GitHubSyncError('INVALID_SYNC_REQUEST', 400);
  const now = new Date();
  const leaseToken = randomUUID();
  try {
    return await transaction(async (session) => {
      await reserveOwner(session, projectId, actorId);
      const link = await ProjectRepository.findOne({ _id: linkId, project: projectId, status: 'active' }).session(session);
      if (!link) throw new GitHubSyncError('GITHUB_REPOSITORY_UNLINKED', 409);
      const installation = await GitHubInstallation.findOne({ _id: link.installation, status: 'active', authorizedUsers: actorId }).session(session);
      if (!installation) throw new GitHubSyncError('GITHUB_INSTALLATION_UNAVAILABLE', 409);
      const active = await GitHubSyncJob.findOne({ repositoryLink: link._id, active: true }).select('+leaseToken +leaseExpiresAt').session(session);
      if (active) return { job: active, claimed: false, created: false };
      const [job] = await GitHubSyncJob.create([makeJobFields({ projectId, link, actorId, now, leaseToken })], { session });
      await appendAuditEvent({
        projectId, actorId, action: 'github.sync.started', targetType: 'github_sync_job', targetId: job._id,
        githubRepository: { repositoryId: link.repositoryId, fullName: link.fullName }, session,
      });
      return { job, claimed: true, created: true };
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const winner = await GitHubSyncJob.findOne({ repositoryLink: linkId, active: true }).select('+leaseToken +leaseExpiresAt');
    if (winner) return { job: winner, claimed: false, created: false };
    throw error;
  }
}

export async function claimGitHubSyncRetry({ projectId, linkId, jobId, actorId, now = new Date() }) {
  if (![projectId, linkId, jobId, actorId].every(validId)) throw new GitHubSyncError('INVALID_SYNC_REQUEST', 400);
  const leaseToken = randomUUID();
  const result = await transaction(async (session) => {
    const link = await ProjectRepository.findOne({ _id: linkId, project: projectId, status: 'active' }).session(session);
    if (!link) throw new GitHubSyncError('GITHUB_REPOSITORY_UNLINKED', 409);
    await assertOwnerAndActiveLink(session, { projectId, actorId, linkId, installationId: link.installation });
    const current = await GitHubSyncJob.findOne({ _id: jobId, project: projectId, repositoryLink: linkId, active: true })
      .select('+leaseToken +leaseExpiresAt').session(session);
    if (!current) throw new GitHubSyncError('GITHUB_SYNC_JOB_NOT_FOUND', 404);
    if (String(current.requestedBy) !== String(actorId)) {
      if (current.status === 'running' && current.leaseExpiresAt?.getTime() > now.getTime()) {
        return { job: current, claimed: false };
      }
      await GitHubSyncJob.updateOne({ _id: current._id, active: true }, {
        $set: { status: 'failed', active: false, retryable: false, lastErrorCode: 'PROJECT_OWNER_CHANGED', lastErrorStatus: 409, completedAt: now, lastProgressAt: now },
        $unset: { leaseToken: 1 },
      }, { session });
      await appendAuditEvent({
        projectId, actorId, action: 'github.sync.failed', targetType: 'github_sync_job', targetId: current._id,
        githubRepository: { repositoryId: link.repositoryId, fullName: link.fullName },
        comment: 'code=PROJECT_OWNER_CHANGED;retryable=false', session,
      });
      return { job: current, claimed: false, ownerChanged: true };
    }
    if (current.status === 'running' && current.leaseExpiresAt?.getTime() > now.getTime()) {
      return { job: current, claimed: false };
    }
    const abandoned = current.status === 'running' && (!current.leaseExpiresAt || current.leaseExpiresAt.getTime() <= now.getTime());
    const retryable = ['partial', 'retry_wait'].includes(current.status) && current.retryable
      && (!current.retryAt || current.retryAt.getTime() <= now.getTime());
    if (!abandoned && !retryable) throw new GitHubSyncError('GITHUB_SYNC_NOT_RETRYABLE', 409);

    const deadlineAt = new Date(now.getTime() + GITHUB_SYNC_DEADLINE_MS);
    const claimed = await GitHubSyncJob.findOneAndUpdate({
      _id: jobId, project: projectId, repositoryLink: linkId, active: true,
      $or: [
        { status: { $in: ['partial', 'retry_wait'] }, retryable: true, $or: [{ retryAt: { $exists: false } }, { retryAt: { $lte: now } }] },
        { status: 'running', $or: [{ leaseExpiresAt: { $exists: false } }, { leaseExpiresAt: { $lte: now } }] },
      ],
    }, {
      $set: { status: 'running', retryable: false, deadlineAt, leaseToken, leaseExpiresAt: new Date(deadlineAt.getTime() + LEASE_GRACE_MS), lastProgressAt: now },
      $unset: { retryAt: 1, lastErrorCode: 1, lastErrorStatus: 1 },
      $inc: { attemptCount: 1 },
    }, { new: true, session }).select('+leaseToken +leaseExpiresAt');
    if (!claimed) throw new GitHubSyncError('GITHUB_SYNC_CLAIM_CONFLICT', 409);
    await appendAuditEvent({
      projectId, actorId, action: 'github.sync.retry_started', targetType: 'github_sync_job', targetId: claimed._id,
      githubRepository: { repositoryId: link.repositoryId, fullName: link.fullName }, session,
    });
    return { job: claimed, claimed: true };
  });
  if (result.ownerChanged) throw new GitHubSyncError('PROJECT_OWNER_CHANGED', 409);
  return result;
}

export async function getGitHubSyncStatus({ projectId, jobId, now = new Date() }) {
  if (![projectId, jobId].every(validId)) throw new GitHubSyncError('INVALID_SYNC_REQUEST', 400);
  const job = await GitHubSyncJob.findOne({ _id: jobId, project: projectId })
    .select('+leaseExpiresAt').lean();
  if (!job) throw new GitHubSyncError('GITHUB_SYNC_JOB_NOT_FOUND', 404);
  const interrupted = job.status === 'running' && (!job.leaseExpiresAt || job.leaseExpiresAt <= now);
  return {
    id: String(job._id),
    project: String(job.project),
    repositoryLink: String(job.repositoryLink),
    status: interrupted ? 'interrupted' : job.status,
    stage: job.stage,
    resultCompleteness: job.resultCompleteness || 'complete',
    retryable: interrupted || Boolean(job.retryable),
    retryAt: job.retryAt || undefined,
    lastErrorCode: job.lastErrorCode || undefined,
    checkpoints: job.checkpoints,
    counts: job.counts,
    attemptCount: job.attemptCount,
    startedAt: job.startedAt,
    deadlineAt: job.deadlineAt,
    completedAt: job.completedAt,
    lastProgressAt: job.lastProgressAt,
  };
}

async function loadJobLease(jobId, leaseToken) {
  const job = await GitHubSyncJob.findOne({ _id: jobId, status: 'running', active: true, leaseToken }).select('+leaseToken +leaseExpiresAt');
  if (!job) throw new GitHubSyncError('GITHUB_SYNC_LEASE_LOST', 409);
  return job;
}

async function checkpoint({ jobId, leaseToken, stage, category, values, counts = {}, resultCompleteness }) {
  const job = await loadJobLease(jobId, leaseToken);
  if (Date.now() + PERSISTENCE_RESERVE_MS >= job.deadlineAt.getTime()) {
    throw new GitHubSyncError('GITHUB_SYNC_DEADLINE', 504, { retryable: true, retryAt: new Date() });
  }
  return transaction(async (session) => {
    const { link, installation, job: current } = await getAuthorizedScope(session, {
      projectId: job.project, actorId: job.requestedBy, linkId: job.repositoryLink, jobId, leaseToken,
    });
    if (Date.now() + 500 >= current.deadlineAt.getTime()) {
      throw new GitHubSyncError('GITHUB_SYNC_DEADLINE', 504, { retryable: true, retryAt: new Date() });
    }
    const set = { stage, lastProgressAt: new Date(), ...(resultCompleteness ? { resultCompleteness } : {}) };
    if (category) set[`checkpoints.${category}`] = { ...current.checkpoints?.[category]?.toObject?.(), ...values, updatedAt: new Date() };
    const inc = {};
    for (const [key, value] of Object.entries(counts)) if (value) inc[`counts.${key}`] = value;
    await GitHubSyncJob.updateOne({ _id: jobId, leaseToken, status: 'running' }, {
      $set: set,
      ...(Object.keys(inc).length ? { $inc: inc } : {}),
    }, { session });
    return { link, installation, current };
  });
}

function sourceDescription({ category, item, repository, link, actorId }) {
  const common = {
    project: link.project,
    provider: 'github',
    repositoryLink: link._id,
    uploadedBy: actorId,
    status: 'processed',
  };
  if (category === 'readme') return {
    ...common, externalType: 'readme', externalId: item.path,
    externalUrl: `https://github.com/${encodeURIComponent(repository.ownerLogin)}/${encodeURIComponent(repository.name)}/blob/${item.sha}/${item.path.split('/').map(encodeURIComponent).join('/')}`,
    originalName: item.path.split('/').at(-1) || item.name, mimeType: 'text/markdown', size: item.contentBytes,
  };
  if (category === 'commits') return {
    ...common, externalType: 'commit', externalId: item.sha,
    externalUrl: `https://github.com/${encodeURIComponent(repository.ownerLogin)}/${encodeURIComponent(repository.name)}/commit/${item.sha}`,
    originalName: `Commit ${item.sha.slice(0, 12)}`, mimeType: 'text/plain', size: item.contentBytes,
    externalUpdatedAt: item.authoredAt,
  };
  return {
    ...common, externalType: 'issue', externalId: String(item.number),
    externalUrl: `https://github.com/${encodeURIComponent(repository.ownerLogin)}/${encodeURIComponent(repository.name)}/issues/${item.number}`,
    originalName: `Issue #${item.number}: ${item.title.slice(0, 180)}`, mimeType: 'text/plain', size: item.contentBytes,
    externalUpdatedAt: item.updatedAt,
  };
}

function sourceRevisionDescription({ category, item, repository }) {
  const textSnapshot = category === 'commits' ? item.message : item.text;
  return {
    revisionKey: item.revisionKey,
    contentHash: item.contentHash,
    textSnapshot,
    providerUpdatedAt: category === 'issues' ? item.updatedAt : item.authoredAt,
    capturedAt: new Date(),
    locator: {
      provider: 'github', externalType: category === 'readme' ? 'readme' : (category === 'commits' ? 'commit' : 'issue'),
      externalId: category === 'readme' ? item.path : (category === 'commits' ? item.sha : String(item.number)),
      repositoryId: repository.repositoryId,
      repositoryFullName: repository.fullName,
      truncated: item.truncated,
      originalBytes: item.originalBytes,
      contentBytes: item.contentBytes,
      ...(category === 'readme' ? { path: item.path, blobSha: item.sha } : {}),
      ...(category === 'commits' ? { commitSha: item.sha, authoredAt: item.authoredAt } : {}),
      ...(category === 'issues' ? { issueNumber: item.number, state: item.state, updatedAt: item.updatedAt } : {}),
    },
  };
}

async function persistOne({ session, category, item, repository, link, actorId }) {
  const identity = category === 'readme' ? item.path : (category === 'commits' ? item.sha : String(item.number));
  const sourceFilter = {
    project: link.project, provider: 'github', repositoryLink: link._id,
    externalType: category === 'readme' ? 'readme' : (category === 'commits' ? 'commit' : 'issue'),
    externalId: identity,
  };
  let source = await Source.findOne(sourceFilter).session(session);
  let sourceCreated = false;
  if (!source) {
    [source] = await Source.create([sourceDescription({ category, item, repository, link, actorId })], { session });
    sourceCreated = true;
  }
  let revision = await SourceRevision.findOne({ source: source._id, revisionKey: item.revisionKey }).session(session);
  const textSnapshot = category === 'commits' ? item.message : item.text;
  let revisionCreated = false;
  if (revision) {
    if (revision.contentHash !== item.contentHash || revision.textSnapshot !== textSnapshot) {
      throw new GitHubSyncError('GITHUB_REVISION_IDENTITY_CONFLICT', 500);
    }
  } else {
    [revision] = await SourceRevision.create([{
      source: source._id,
      ...sourceRevisionDescription({ category, item, repository }),
    }], { session });
    revisionCreated = true;
  }
  await Source.updateOne({ _id: source._id, project: link.project, repositoryLink: link._id, provider: 'github' }, {
    $set: {
      currentRevision: revision._id,
      extractedText: revision.textSnapshot,
      status: 'processed',
      originalName: sourceDescription({ category, item, repository, link, actorId }).originalName,
      mimeType: sourceDescription({ category, item, repository, link, actorId }).mimeType,
      size: revision.locator?.contentBytes ?? item.contentBytes,
      ...(category === 'issues' ? { externalUpdatedAt: item.updatedAt } : {}),
      ...(category === 'commits' && item.authoredAt ? { externalUpdatedAt: item.authoredAt } : {}),
    },
  }, { session });
  return { sourceCreated, revisionCreated };
}

async function persistBatch({ jobId, leaseToken, category, items, repository, progress, countsDelta = {} }) {
  const job = await loadJobLease(jobId, leaseToken);
  if (Date.now() + PERSISTENCE_RESERVE_MS >= job.deadlineAt.getTime()) {
    throw new GitHubSyncError('GITHUB_SYNC_DEADLINE', 504, { retryable: true, retryAt: new Date() });
  }
  let outcome;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      outcome = await transaction(async (session) => {
        const scope = await getAuthorizedScope(session, {
          projectId: job.project, actorId: job.requestedBy, linkId: job.repositoryLink, jobId, leaseToken,
        });
        let sourcesCreated = 0;
        let revisionsCreated = 0;
        let revisionsReused = 0;
        for (const item of items) {
          const saved = await persistOne({ session, category, item, repository, link: scope.link, actorId: job.requestedBy });
          sourcesCreated += Number(saved.sourceCreated);
          revisionsCreated += Number(saved.revisionCreated);
          revisionsReused += Number(!saved.revisionCreated);
        }
        const persistedJob = await getSyncDocument(jobId, session, { privateFields: true });
        if (!persistedJob || Date.now() + 500 >= persistedJob.deadlineAt.getTime()) {
          throw new GitHubSyncError('GITHUB_SYNC_DEADLINE', 504, { retryable: true, retryAt: new Date() });
        }
        const key = `checkpoints.${category}`;
        const currentCheckpoint = scope.job.checkpoints?.[category]?.toObject?.() || {};
        const nextCheckpoint = { ...currentCheckpoint, ...progress, sourcesCreated: (currentCheckpoint.sourcesCreated || 0) + sourcesCreated,
          revisionsCreated: (currentCheckpoint.revisionsCreated || 0) + revisionsCreated,
          revisionsReused: (currentCheckpoint.revisionsReused || 0) + revisionsReused,
          contentBytes: (currentCheckpoint.contentBytes || 0) + items.reduce((sum, item) => sum + item.contentBytes, 0),
          updatedAt: new Date() };
        const inc = {
          'counts.sourcesCreated': sourcesCreated,
          'counts.revisionsCreated': revisionsCreated,
          'counts.revisionsReused': revisionsReused,
          'counts.contentBytes': items.reduce((sum, item) => sum + item.contentBytes, 0),
          ...(category === 'commits' ? { 'counts.commitsCaptured': items.length } : {}),
          ...(category === 'issues' ? { 'counts.issuesCaptured': items.length } : {}),
        };
        for (const [key, value] of Object.entries(countsDelta)) {
          if (Number.isSafeInteger(value) && value > 0) inc[`counts.${key}`] = value;
        }
        await GitHubSyncJob.updateOne({ _id: jobId, leaseToken, status: 'running' }, {
          $set: { [key]: nextCheckpoint, stage: category === 'readme' ? 'readme' : category, lastProgressAt: new Date() },
          $inc: inc,
        }, { session });
        return { sourcesCreated, revisionsCreated, revisionsReused };
      });
      return outcome;
    } catch (error) {
      if (error?.code !== 11000 || attempt === 2) throw error;
    }
  }
  return outcome;
}

async function updateCheckpointProgress({ jobId, leaseToken, category, stage, progress, counts = {}, resultCompleteness }) {
  return checkpoint({ jobId, leaseToken, stage, category, values: progress, counts, resultCompleteness });
}

async function refreshAndVerify({ jobId, leaseToken, repositoryLink, installation, actorId }) {
  let status = installation.status;
  const lastVerifiedAt = installation.lastVerifiedAt?.getTime?.() || 0;
  let latest;
  if (Date.now() - lastVerifiedAt > INSTALLATION_STATUS_FRESH_MS) {
    try {
      latest = await getInstallation({
        installationId: installation.installationId,
        timeoutMs: await authorizeProviderCall(jobId, leaseToken, { allowStaleInstallation: true }),
      });
      status = safeInstallationStatus(latest);
    } catch (error) {
      if (error instanceof GitHubApiError && error.code === 'GITHUB_RESOURCE_UNAVAILABLE') status = 'removed';
      else throw error;
    }
    await transaction(async (session) => {
      const { link, installation: current } = await getAuthorizedScope(session, {
        projectId: repositoryLink.project, actorId, linkId: repositoryLink._id, jobId, leaseToken, allowStaleInstallation: true,
      });
      const nextStatus = status;
      await GitHubInstallation.updateOne({ _id: current._id }, { $set: {
        status: nextStatus,
        lastVerifiedAt: new Date(),
        ...(latest && nextStatus === 'active' ? {
          accountId: String(latest.account.id), accountLogin: latest.account.login,
          accountType: latest.account.type, grantedPermissions: latest.permissions || {},
        } : {}),
      } }, { session });
      if (current.status !== nextStatus) await appendAuditEvent({
        projectId: repositoryLink.project, actorId, action: `github.installation.${nextStatus}`,
        targetType: 'github_installation', targetId: current._id, session,
      });
      if (!link) throw new GitHubSyncError('GITHUB_REPOSITORY_UNLINKED', 409);
    });
  }
  if (status === 'suspended') throw new GitHubSyncError('GITHUB_INSTALLATION_SUSPENDED', 409);
  if (status === 'removed') throw new GitHubSyncError('GITHUB_INSTALLATION_REMOVED', 404);

  const timeoutMs = await authorizeProviderCall(jobId, leaseToken);
  let repository;
  try {
    repository = await getInstallationRepository({
      installationId: installation.installationId,
      repositoryId: repositoryLink.repositoryId,
      timeoutMs,
      getTimeoutMs: async () => authorizeProviderCall(jobId, leaseToken),
    });
  } catch (error) {
    if (error instanceof GitHubApiError && ['GITHUB_RESOURCE_UNAVAILABLE', 'GITHUB_ACCESS_DENIED'].includes(error.code)) {
      throw new GitHubSyncError('GITHUB_REPOSITORY_ACCESS_UNAVAILABLE', 409);
    }
    throw error;
  }
  if (!repository || String(repository.id) !== String(repositoryLink.repositoryId)
    || typeof repository.owner?.login !== 'string' || typeof repository.name !== 'string'
    || !/^[A-Za-z0-9_.-]{1,100}$/.test(repository.owner.login)
    || !/^[A-Za-z0-9_.-]{1,100}$/.test(repository.name)) {
    throw new GitHubSyncError('GITHUB_REPOSITORY_IDENTITY_MISMATCH', 502);
  }
  return {
    repositoryId: String(repository.id), ownerLogin: repository.owner.login,
    name: repository.name, fullName: `${repository.owner.login}/${repository.name}`,
    defaultBranch: typeof repository.default_branch === 'string' ? repository.default_branch : repositoryLink.defaultBranch,
  };
}

async function findKnownContent({ projectId, repositoryLink }) {
  const sources = await Source.find({ project: projectId, repositoryLink, provider: 'github' })
    .select('externalType externalId externalUpdatedAt').lean();
  return {
    commitShas: sources.filter((source) => source.externalType === 'commit').map((source) => source.externalId),
    issueUpdatedAt: new Map(sources.filter((source) => source.externalType === 'issue')
      .map((source) => [String(source.externalId), source.externalUpdatedAt || new Date(0)])),
  };
}

function contentBudgetFor(job) {
  const used = job.counts?.contentBytes || 0;
  return createGitHubContentBudget({
    totalLimit: Math.max(0, GITHUB_CONTENT_LIMITS.total - used),
    categoryLimits: {
      readme: Math.max(0, GITHUB_CONTENT_LIMITS.readmeItem - (job.checkpoints?.readme?.contentBytes || 0)),
      commits: Math.max(0, GITHUB_CONTENT_LIMITS.commits - (job.checkpoints?.commits?.contentBytes || 0)),
      issues: Math.max(0, GITHUB_CONTENT_LIMITS.issues - (job.checkpoints?.issues?.contentBytes || 0)),
    },
  });
}

async function persistSingle({ jobId, leaseToken, category, item, repository }) {
  return persistBatch({ jobId, leaseToken, category, items: [item], repository, progress: { status: 'completed', itemsFetched: 1, page: 1 } });
}

async function fetchAndPersist(jobId, leaseToken) {
  let job = await loadJobLease(jobId, leaseToken);
  const link = await ProjectRepository.findOne({ _id: job.repositoryLink, project: job.project, status: 'active' });
  if (!link) throw new GitHubSyncError('GITHUB_REPOSITORY_UNLINKED', 409);
  let installation = await GitHubInstallation.findOne({ _id: job.installation, authorizedUsers: job.requestedBy }).select('+installationId');
  if (!installation) throw new GitHubSyncError('GITHUB_INSTALLATION_UNAVAILABLE', 409);
  const repository = await refreshAndVerify({ jobId, leaseToken, repositoryLink: link, installation, actorId: job.requestedBy });
  const budget = contentBudgetFor(job);

  job = await loadJobLease(jobId, leaseToken);
  if (!['completed', 'skipped'].includes(job.checkpoints.readme.status)) {
    await updateCheckpointProgress({ jobId, leaseToken, category: 'readme', stage: 'readme', progress: { status: 'running' } });
    const readme = await getRepositoryReadme({
      installationId: installation.installationId, ownerLogin: repository.ownerLogin, repositoryName: repository.name,
      contentBudget: budget, getTimeoutMs: async () => authorizeProviderCall(jobId, leaseToken),
    });
    if (readme) await persistSingle({ jobId, leaseToken, category: 'readme', item: readme, repository });
    await updateCheckpointProgress({
      jobId, leaseToken, category: 'readme', stage: 'commits',
      progress: { status: readme ? 'completed' : 'skipped', page: 1, itemsFetched: readme ? 1 : 0 },
    });
  }

  job = await loadJobLease(jobId, leaseToken);
  if (job.checkpoints.commits.status !== 'completed') {
    await updateCheckpointProgress({ jobId, leaseToken, category: 'commits', stage: 'commits', progress: { status: 'running' } });
    const initialCompletedItems = job.checkpoints.commits.itemsFetched || 0;
    const initialCompletedBatches = job.checkpoints.commits.lastCompletedBatch || 0;
    const known = await findKnownContent({ projectId: job.project, repositoryLink: link._id });
    const commits = await getRecentRepositoryCommits({
      installationId: installation.installationId, ownerLogin: repository.ownerLogin, repositoryName: repository.name,
      defaultBranch: repository.defaultBranch, contentBudget: budget, excludeShas: known.commitShas,
      getTimeoutMs: async () => authorizeProviderCall(jobId, leaseToken),
    });
    for (let offset = 0; offset < commits.length; offset += COMMIT_BATCH_SIZE) {
      const batch = commits.slice(offset, offset + COMMIT_BATCH_SIZE);
      await persistBatch({ jobId, leaseToken, category: 'commits', items: batch, repository,
        progress: { status: 'running', page: 1, itemsFetched: initialCompletedItems + offset + batch.length, lastCompletedBatch: initialCompletedBatches + Math.floor(offset / COMMIT_BATCH_SIZE) + 1 } });
    }
    const latest = await loadJobLease(jobId, leaseToken);
    await updateCheckpointProgress({ jobId, leaseToken, category: 'commits', stage: 'issues', progress: {
      status: 'completed', page: 1,
      itemsFetched: latest.checkpoints.commits.itemsFetched || initialCompletedItems,
      lastCompletedBatch: latest.checkpoints.commits.lastCompletedBatch || initialCompletedBatches,
    } });
  }

  job = await loadJobLease(jobId, leaseToken);
  if (job.checkpoints.issues.status !== 'completed') {
    await updateCheckpointProgress({ jobId, leaseToken, category: 'issues', stage: 'issues', progress: { status: 'running' } });
    const known = await findKnownContent({ projectId: job.project, repositoryLink: link._id });
    const existingCheckpoint = job.checkpoints.issues;
    const issueResult = await listRecentRepositoryIssues({
      installationId: installation.installationId, ownerLogin: repository.ownerLogin, repositoryName: repository.name,
      contentBudget: budget, startPage: Math.max(1, (existingCheckpoint.page || 0) + 1),
      initialIssueCount: existingCheckpoint.itemsFetched || 0,
      initialPagesScanned: existingCheckpoint.pagesScanned || 0,
      initialRawEntriesScanned: existingCheckpoint.rawEntriesScanned || 0,
      knownIssueUpdatedAtByNumber: known.issueUpdatedAt,
      getTimeoutMs: async () => authorizeProviderCall(jobId, leaseToken),
      onPage: async (page) => {
        const categoryComplete = page.exhausted || page.issueLimitReached || page.scanLimitReached;
        await persistBatch({
          jobId, leaseToken, category: 'issues', items: page.pageIssues, repository,
          countsDelta: { pullRequestsSkipped: page.pullRequestsSkipped },
          progress: {
            status: categoryComplete ? 'completed' : 'running', page: page.page,
            pagesScanned: page.pagesScanned, rawEntriesScanned: page.rawEntriesScanned,
            itemsFetched: page.issueCount, ...(page.scanLimitReached ? { partialReason: 'issue_scan_limit_reached' } : {}),
          },
        });
        if (page.scanLimitReached) {
          await updateCheckpointProgress({ jobId, leaseToken, category: 'issues', stage: 'finalize',
            progress: { status: 'completed', partialReason: 'issue_scan_limit_reached' }, resultCompleteness: 'partial' });
        }
      },
    });
    if (issueResult.partialReason) {
      const latest = await loadJobLease(jobId, leaseToken);
      if (latest.resultCompleteness !== 'partial') await updateCheckpointProgress({
        jobId, leaseToken, category: 'issues', stage: 'finalize',
        progress: { status: 'completed', partialReason: issueResult.partialReason }, resultCompleteness: 'partial',
      });
    } else {
      const latest = await loadJobLease(jobId, leaseToken);
      await updateCheckpointProgress({ jobId, leaseToken, category: 'issues', stage: 'finalize', progress: {
        status: 'completed', page: issueResult.pagesScanned, pagesScanned: issueResult.pagesScanned,
        rawEntriesScanned: issueResult.rawEntriesScanned, itemsFetched: issueResult.issueCount,
      } });
    }
  }
}

async function finishSync({ jobId, leaseToken }) {
  const candidate = await loadJobLease(jobId, leaseToken);
  return transaction(async (session) => {
    const job = await getSyncDocument(jobId, session, { privateFields: true });
    if (!job || job.status !== 'running' || !job.active || job.leaseToken !== leaseToken) throw new GitHubSyncError('GITHUB_SYNC_LEASE_LOST', 409);
    const { link } = await getAuthorizedScope(session, {
      projectId: job.project, actorId: job.requestedBy, linkId: job.repositoryLink,
      jobId, leaseToken,
    });
    await GitHubSyncJob.updateOne({ _id: jobId, leaseToken, status: 'running' }, {
      $set: { status: 'completed', active: false, retryable: false, completedAt: new Date(), lastProgressAt: new Date(), stage: 'finalize' },
      $unset: { leaseToken: 1 },
    }, { session });
    await appendAuditEvent({
      projectId: job.project, actorId: job.requestedBy,
      action: candidate.resultCompleteness === 'partial' ? 'github.sync.completed_partial' : 'github.sync.completed',
      targetType: 'github_sync_job', targetId: job._id,
      githubRepository: link ? { repositoryId: link.repositoryId, fullName: link.fullName } : undefined,
      comment: `sources=${job.counts?.sourcesCreated || 0};revisions=${job.counts?.revisionsCreated || 0};reused=${job.counts?.revisionsReused || 0};contentBytes=${job.counts?.contentBytes || 0}`,
      session,
    });
  });
}

async function failSync({ jobId, leaseToken, error }) {
  const failure = classifyFailure(error);
  try {
    await transaction(async (session) => {
      const job = await getSyncDocument(jobId, session, { privateFields: true });
      if (!job || job.status !== 'running' || !job.active || job.leaseToken !== leaseToken) return;
      const now = new Date();
      const canRetry = failure.retryable && job.attemptCount < 10;
      const status = canRetry ? (failure.retryAt && failure.retryAt > now ? 'retry_wait' : 'partial') : 'failed';
      const link = await ProjectRepository.findById(job.repositoryLink).session(session);
      await GitHubSyncJob.updateOne({ _id: jobId, leaseToken, status: 'running' }, {
        $set: {
          status, active: canRetry, retryable: canRetry,
          ...(canRetry && failure.retryAt ? { retryAt: failure.retryAt } : {}),
          lastErrorCode: failure.code, lastErrorStatus: failure.status,
          completedAt: canRetry ? undefined : now,
          lastProgressAt: now,
        },
        $unset: { leaseToken: 1 },
      }, { session });
      await appendAuditEvent({
        projectId: job.project, actorId: job.requestedBy,
        action: canRetry ? 'github.sync.partial' : 'github.sync.failed',
        targetType: 'github_sync_job', targetId: job._id,
        githubRepository: link ? { repositoryId: link.repositoryId, fullName: link.fullName } : undefined,
        comment: `code=${failure.code};retryable=${canRetry}`,
        session,
      });
    });
  } catch {
    // A process may lose its lease or the database may be unavailable. The lease
    // expiry remains the recovery mechanism; raw exceptions are never logged.
  }
  return failure;
}

async function executeClaimedSync({ job, leaseToken }) {
  try {
    await fetchAndPersist(job._id, leaseToken);
    await finishSync({ jobId: job._id, leaseToken });
  } catch (error) {
    await failSync({ jobId: job._id, leaseToken, error });
  }
  return getGitHubSyncStatus({ projectId: job.project, jobId: job._id });
}

export async function startGitHubSync({ projectId, linkId, actorId }) {
  const claim = await claimGitHubSync({ projectId, linkId, actorId });
  if (claim.claimed) {
    const leaseToken = claim.job.leaseToken;
    const status = await executeClaimedSync({ job: claim.job, leaseToken });
    return { created: claim.created, status };
  }
  return { created: false, status: await getGitHubSyncStatus({ projectId, jobId: claim.job._id }) };
}

export async function retryGitHubSync({ projectId, linkId, jobId, actorId }) {
  if (!linkId && validId(projectId) && validId(jobId)) {
    const existing = await GitHubSyncJob.findOne({ _id: jobId, project: projectId }).select('repositoryLink');
    if (!existing) throw new GitHubSyncError('GITHUB_SYNC_JOB_NOT_FOUND', 404);
    linkId = existing.repositoryLink;
  }
  const claim = await claimGitHubSyncRetry({ projectId, linkId, jobId, actorId });
  if (claim.claimed) {
    const status = await executeClaimedSync({ job: claim.job, leaseToken: claim.job.leaseToken });
    return { executed: true, status };
  }
  return { executed: false, status: await getGitHubSyncStatus({ projectId, jobId }) };
}
