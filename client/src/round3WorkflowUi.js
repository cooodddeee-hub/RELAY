export function contradictionStatusLabel(status) {
  return status === 'confirmed_conflict' ? 'Confirmed conflict'
    : status === 'dismissed' ? 'Dismissed'
      : status === 'stale_information' ? 'Stale information'
        : status === 'resolved' ? 'Resolved'
          : status === 'in_review' ? 'Suspected · in review' : 'Suspected';
}

export function canReviewContradiction({ mode, project, userId, assignments = [], candidate }) {
  if (mode !== 'real' || !project || !userId || !candidate) return false;
  const memberRole = String(project.owner) === String(userId)
    ? 'owner'
    : project.members?.find((member) => String(member.user?._id || member.user) === String(userId))?.role;
  if (!memberRole) return false;
  if (project.workflowPolicy?.reviewMode !== 'assigned') return memberRole === 'owner' || memberRole === 'editor';
  const categories = [...new Set((candidate.claims || []).map((claim) => claim.category || claim.finding?.category).filter(Boolean))];
  return categories.length > 0 && categories.every((category) => assignments.some((assignment) =>
    assignment.role === 'reviewer' && assignment.status === 'active'
    && String(assignment.user?._id || assignment.user) === String(userId)
    && (assignment.scopeType === 'project' || assignment.scopeType === 'category' && assignment.scopeValue === category)));
}

export function canReadProjectAudit({ mode, project, userId, assignments = [] }) {
  if (mode !== 'real' || !project || !userId) return false;
  if (String(project.owner) === String(userId)) return true;
  return assignments.some((assignment) => assignment.role === 'audit_reader' && assignment.status === 'active'
    && String(assignment.user?._id || assignment.user) === String(userId)
    && (assignment.scopeType === 'project' || assignment.scopeType === 'category' || assignment.scopeType === 'handover'));
}

export function validateReviewerRationale(value) {
  const rationale = typeof value === 'string' ? value.trim() : '';
  return rationale.length >= 1 && rationale.length <= 2000 ? { valid: true, value: rationale } : { valid: false, value: rationale };
}

export function contradictionEvidenceView(item = {}) {
  const source = item.source || {};
  const revision = item.sourceRevision || {};
  const locator = item.locator || revision.locator || {};
  return {
    sourceName: source.originalName || item.sourceName || 'Source',
    revisionKey: revision.revisionKey || revision._id || item.sourceRevision || 'revision unavailable',
    locator: [locator.repositoryFullName, locator.path, locator.issueNumber ? `Issue #${locator.issueNumber}` : '', locator.commitSha ? `Commit ${String(locator.commitSha).slice(0, 12)}` : ''].filter(Boolean).join(' · '),
    verifiedText: item.matchedText || item.quote || 'Evidence text unavailable.',
    verified: Boolean(item.matchedText && item.quote),
  };
}

export function canSignHandover({ mode, project, userId, assignments = [], handover }) {
  if (mode !== 'real' || !project || !userId || !handover || project.workflowPolicy?.signoffMode !== 'assigned') return false;
  const isMember = String(project.owner) === String(userId)
    || project.members?.some((member) => String(member.user?._id || member.user) === String(userId));
  if (!isMember || String(handover.createdBy?._id || handover.createdBy) === String(userId)) return false;
  if ((handover.effectiveStatus || handover.approvalStatus) !== 'pending') return false;
  return assignments.some((assignment) => assignment.role === 'approver' && assignment.status === 'active'
    && String(assignment.user?._id || assignment.user) === String(userId)
    && (assignment.scopeType === 'project' || assignment.scopeType === 'handover' && assignment.scopeValue === String(handover._id)));
}

export function validateSignoffInput({ decision, comment, reason }) {
  const cleanComment = typeof comment === 'string' ? comment.trim() : '';
  const cleanReason = typeof reason === 'string' ? reason.trim() : '';
  const validDecision = ['approved', 'rejected'].includes(decision);
  const valid = validDecision && cleanComment.length > 0 && cleanComment.length <= 5000
    && (decision !== 'rejected' || cleanReason.length > 0 && cleanReason.length <= 2000);
  return { valid, comment: cleanComment, reason: cleanReason };
}

export function isDeletionRecoverable(deletion, now = Date.now()) {
  return deletion?.deletionState === 'queued'
    && ['queued', 'retry_wait'].includes(deletion.job?.status)
    && Boolean(deletion.recoveryEndsAt)
    && now < new Date(deletion.recoveryEndsAt).getTime();
}

export function projectDeletionCardPresentation(project = {}, now = Date.now()) {
  const state = project.deletionState || 'active';
  const requestedAt = project.deletionRequestedAt ? new Date(project.deletionRequestedAt) : null;
  const recoveryEndsAt = state === 'queued' && requestedAt && Number.isFinite(requestedAt.getTime())
    ? new Date(requestedAt.getTime() + 30 * 24 * 60 * 60 * 1000) : null;
  const recoverable = Boolean(recoveryEndsAt && now < recoveryEndsAt.getTime());
  return {
    state,
    label: state === 'active' ? String(project.status || 'active').toUpperCase()
      : state === 'queued' ? recoverable ? 'RECOVERABLE · DELETING' : 'DELETION QUEUED'
        : state === 'purging' ? 'CLEANUP IN PROGRESS' : state === 'blocked' ? 'CLEANUP BLOCKED' : 'DELETED',
    recoveryEndsAt,
    recoverable,
    destination: state === 'active' ? 'sources' : 'settings',
  };
}

export function dashboardMetrics(projects = [], findings = []) {
  const active = projects.filter((project) => !project.deletionState || project.deletionState === 'active');
  return {
    activeProjects: active.length,
    inReviewProjects: active.filter((project) => project.status === 'review').length,
    completedProjects: active.filter((project) => project.status === 'completed').length,
    recoveryProjects: projects.filter((project) => project.deletionState && project.deletionState !== 'active').length,
    pendingFindings: findings.filter((finding) => finding.status === 'pending').length,
    approvedFindings: findings.filter((finding) => finding.status === 'approved').length,
  };
}

export function projectCardMetrics(project = {}, { selected = false, sources = [], findings = [], sourcesUnavailable = false, findingsUnavailable = false } = {}) {
  const pending = findings.filter((finding) => finding.status === 'pending').length;
  return {
    teamMembers: 1 + (project.members || []).filter((member) => String(member.user?._id || member.user) !== String(project.owner)).length,
    sources: !selected ? null : sourcesUnavailable ? null : sources.length,
    findings: !selected ? null : findingsUnavailable ? null : findings.length,
    pending: !selected || findingsUnavailable ? null : pending,
  };
}

export function deletionErrorMessage(code) {
  return ({
    UNSAFE_STORAGE_PATH: 'A stored file path failed safety checks. Cleanup is paused and will retry after it is corrected.',
    STORAGE_METADATA_INCOMPLETE: 'Stored-file metadata is incomplete. Cleanup is paused and retryable.',
    STORAGE_CONFIGURATION_MISMATCH: 'Storage settings do not match this file. Cleanup is paused and retryable.',
    OBJECT_STORAGE_DELETE_FAILED: 'Private storage could not remove a file. Cleanup will retry.',
    LOCAL_FILE_DELETE_FAILED: 'Local storage could not remove a file. Cleanup will retry.',
  })[code] || 'Cleanup could not finish. The server will retry safely.';
}
