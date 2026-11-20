import AuditEvent from '../models/AuditEvent.js';
import { retentionExpiry } from '../config/retention.js';

const MAX_REASON_LENGTH = 2000;
const MAX_COMMENT_LENGTH = 5000;

export async function appendAuditEvent({
  projectId, actorId, action, targetType, targetId, scopeType = 'project', scopeValue,
  reason, comment, requestId, policyVersion, githubRepository, session, now = new Date(),
}) {
  const safeGithubRepository = githubRepository
    && /^\d{1,24}$/.test(String(githubRepository.repositoryId || ''))
    && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(githubRepository.fullName || ''))
    && githubRepository.fullName.length <= 300
    ? { repositoryId: String(githubRepository.repositoryId), fullName: githubRepository.fullName }
    : undefined;
  const event = {
    projectId,
    actorId,
    action,
    targetType,
    targetId,
    scopeType,
    scopeValue,
    reason: typeof reason === 'string' ? reason.slice(0, MAX_REASON_LENGTH) : undefined,
    comment: typeof comment === 'string' ? comment.slice(0, MAX_COMMENT_LENGTH) : undefined,
    requestId: typeof requestId === 'string' ? requestId.slice(0, 200) : undefined,
    policyVersion: typeof policyVersion === 'string' ? policyVersion.slice(0, 100) : undefined,
    githubRepository: safeGithubRepository,
    createdAt: now,
    expiresAt: retentionExpiry('audit', { now }),
  };
  const [saved] = await AuditEvent.create([event], session ? { session } : {});
  return saved;
}
