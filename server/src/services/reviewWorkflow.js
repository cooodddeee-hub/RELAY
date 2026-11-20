import { assertCanReviewProject as assertProjectReviewPermission, canEditProject, projectRole as resolveProjectRole } from './projectPermissions.js';
const categories = new Set(['Decision', 'Completed Work', 'Pending Tasks', 'Responsibilities', 'Blockers', 'Dependencies', 'Risks', 'Next Actions', 'Unresolved Questions']);
const editableFields = new Set(['title', 'description', 'category']);

export class ReviewWorkflowError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'ReviewWorkflowError'; this.status = status; }
}

export function projectRole(project, userId) {
  return resolveProjectRole(project, userId);
}

export function canReviewProject(project, userId) {
  return canEditProject(project, userId);
}

export function assertCanReviewProject(project, userId) {
  try { assertProjectReviewPermission(project, userId); }
  catch (error) { throw new ReviewWorkflowError(error.message, error.status); }
}

function commentValue(value, label, required) {
  if (typeof value !== 'string') {
    if (required) throw new ReviewWorkflowError(`${label} is required.`);
    return '';
  }
  const result = value.trim();
  if (required && !result) throw new ReviewWorkflowError(`${label} is required.`);
  if (result.length > 2000) throw new ReviewWorkflowError(`${label} must be 2,000 characters or fewer.`);
  return result;
}

export function buildReviewChange(finding, actorId, action, payload = {}, now = new Date()) {
  if (!['approve', 'reject', 'clarify', 'edit', 'reopen'].includes(action)) throw new ReviewWorkflowError('Unknown review action.');
  const allowedPayloadKeys = action === 'edit' ? editableFields : ['reject', 'reopen'].includes(action) ? new Set(['reason']) : action === 'clarify' ? new Set(['comment']) : new Set();
  if (Object.keys(payload).some((key) => !allowedPayloadKeys.has(key))) throw new ReviewWorkflowError('Request contains fields that are not allowed for this review action.');
  const currentStatus = finding.status || 'pending';
  const previousValues = { status: currentStatus };
  const updatedValues = {};
  const findingUpdates = {};
  let historyAction = action;
  let reason;
  let comment;

  if (action === 'reopen') {
    if (currentStatus !== 'approved') throw new ReviewWorkflowError('Only approved findings can be reopened.', 409);
    reason = commentValue(payload.reason, 'Reopening reason', true);
    findingUpdates.status = 'pending';
    updatedValues.status = 'pending';
    updatedValues.reason = reason;
    historyAction = 'reopened';
  } else if (action === 'edit') {
    if (!['pending', 'needs_clarification'].includes(currentStatus)) throw new ReviewWorkflowError('Only pending or clarification-needed findings can be edited.', 409);
    const keys = Object.keys(payload);
    if (!keys.length || keys.some((key) => !editableFields.has(key))) throw new ReviewWorkflowError('Provide one or more editable fields: title, description, category.');
    for (const key of keys) {
      const rawValue = payload[key];
      if (typeof rawValue !== 'string') throw new ReviewWorkflowError(`${key} must be text.`);
      const value = rawValue.trim();
      if (key === 'title' && (!value || value.length > 500)) throw new ReviewWorkflowError('Title is required and must be 500 characters or fewer.');
      if (key === 'description' && (!value || value.length > 5000)) throw new ReviewWorkflowError('Description is required and must be 5,000 characters or fewer.');
      if (key === 'category' && !categories.has(value)) throw new ReviewWorkflowError('Choose a valid finding category.');
      if (value === finding[key]) continue;
      previousValues[key] = finding[key];
      updatedValues[key] = value;
      findingUpdates[key] = value;
    }
    if (!Object.keys(updatedValues).length) throw new ReviewWorkflowError('No finding fields changed.');
    if (currentStatus === 'needs_clarification') {
      findingUpdates.status = 'pending';
      previousValues.status = currentStatus;
      updatedValues.status = 'pending';
      historyAction = 'returned_to_pending';
    } else historyAction = 'edited';
  } else {
    if (currentStatus !== 'pending') throw new ReviewWorkflowError('Only pending findings can be approved, rejected, or sent for clarification.', 409);
    const status = { approve: 'approved', reject: 'rejected', clarify: 'needs_clarification' }[action];
    reason = action === 'reject' ? commentValue(payload.reason, 'Rejection reason', true) : undefined;
    comment = action === 'clarify' ? commentValue(payload.comment, 'Clarification comment', true) : undefined;
    findingUpdates.status = status;
    updatedValues.status = status;
    if (action === 'reject') updatedValues.reason = reason;
    if (action === 'clarify') updatedValues.comment = comment;
    historyAction = { approve: 'approved', reject: 'rejected', clarify: 'clarification_requested' }[action];
  }

  findingUpdates.reviewedBy = actorId;
  findingUpdates.reviewedAt = now;
  if (reason || comment) findingUpdates.reviewerComments = [...(finding.reviewerComments || []), { user: actorId, comment: reason || comment, createdAt: now }];
  updatedValues.reviewedBy = actorId;
  updatedValues.reviewedAt = now;
  return { findingUpdates, history: { action: historyAction, previousValues, updatedValues, reason, comment } };
}

/**
 * Run the same review transition against a transactional repository. The
 * injected adapter keeps state rules testable without writing to a real DB.
 */
export async function runReviewAction({ findingId, projectId, actorId, action, payload, transaction, authorizeReview }) {
  return transaction(async (repository) => {
    const finding = await repository.findFinding(findingId, projectId);
    if (!finding) throw new ReviewWorkflowError('Finding not found.', 404);
    if (authorizeReview) await authorizeReview({ finding, repository, action, payload });
    const change = buildReviewChange(finding, actorId, action, payload);
    Object.assign(finding, change.findingUpdates);
    await repository.saveFinding(finding);
    await repository.appendHistory({ finding: findingId, project: projectId, reviewer: actorId, ...change.history });
    if (repository.appendAuditEvent) {
      await repository.appendAuditEvent({ finding, projectId, actorId, change });
    }
    return finding;
  });
}
