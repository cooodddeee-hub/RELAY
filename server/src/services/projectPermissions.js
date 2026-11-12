export function projectRole(project, userId) {
  if (String(project.owner) === String(userId)) return 'owner';
  const membership = project.members?.find((member) => String(member.user?._id || member.user) === String(userId));
  return membership ? (membership.role || 'viewer') : null;
}

export function canReadProject(project, userId) {
  return ['owner', 'editor', 'viewer'].includes(projectRole(project, userId));
}

export function canEditProject(project, userId) {
  return ['owner', 'editor'].includes(projectRole(project, userId));
}

export function canManageProjectMembers(project, userId) {
  return projectRole(project, userId) === 'owner';
}

export function assertCanReviewProject(project, userId) {
  if (!canEditProject(project, userId)) {
    const error = new Error('Only project owners and editors can change finding reviews.');
    error.status = 403;
    throw error;
  }
}
