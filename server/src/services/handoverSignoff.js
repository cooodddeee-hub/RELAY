export function effectiveHandoverStatus(handover, latestVersion) {
  if (handover.approvalStatus === 'pending' && Number.isInteger(latestVersion) && handover.version < latestVersion) return 'superseded';
  return handover.approvalStatus || 'draft';
}

export function validateSignoffDecision({ handover, latestVersion, actorId, decision, comment, reason }) {
  if (!['approved', 'rejected'].includes(decision)) {
    const error = new Error('Choose approval or rejection.'); error.status = 400; throw error;
  }
  if (String(handover.createdBy) === String(actorId)) {
    const error = new Error('The handover creator cannot sign off their own version.'); error.status = 403; throw error;
  }
  if (effectiveHandoverStatus(handover, latestVersion) === 'superseded') {
    const error = new Error('This handover version is superseded and cannot receive a sign-off.'); error.status = 409; throw error;
  }
  if (handover.approvalStatus !== 'pending') {
    const error = new Error('This handover version is not pending sign-off.'); error.status = 409; throw error;
  }
  if (typeof comment !== 'string' || !comment.trim() || comment.trim().length > 5000) {
    const error = new Error('A comment of 1 to 5,000 characters is required.'); error.status = 400; throw error;
  }
  if (decision === 'rejected' && (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 2000)) {
    const error = new Error('A rejection reason of 1 to 2,000 characters is required.'); error.status = 400; throw error;
  }
  if (decision === 'approved' && reason !== undefined && (typeof reason !== 'string' || reason.trim().length > 2000)) {
    const error = new Error('Reason must be 2,000 characters or fewer.'); error.status = 400; throw error;
  }
}
