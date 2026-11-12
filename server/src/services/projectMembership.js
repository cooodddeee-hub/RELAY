export class ProjectMembershipError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'ProjectMembershipError'; this.status = status; }
}

export function visibleProjectsFilter(userId) {
  return { $or: [{ owner: userId }, { 'members.user': userId }] };
}

export function normalizeMemberEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ProjectMembershipError('Enter a valid email address.');
  return email;
}

export function validateMemberRole(role) {
  if (!['editor', 'viewer'].includes(role)) throw new ProjectMembershipError('Role must be Editor or Viewer.');
  return role;
}

export function prepareMemberAddition(project, user, role) {
  if (!user) throw new ProjectMembershipError('No registered RELAY account was found for that email.', 404);
  validateMemberRole(role);
  if (String(user._id) === String(project.owner)) throw new ProjectMembershipError('The project owner is already part of this project.', 409);
  if (project.members?.some((member) => String(member.user?._id || member.user) === String(user._id))) throw new ProjectMembershipError('This user is already a member of the project.', 409);
  return { user: user._id, role };
}

export function prepareMemberRoleChange(project, memberId, role) {
  validateMemberRole(role);
  if (String(memberId) === String(project.owner)) throw new ProjectMembershipError('The project owner role cannot be changed.', 400);
  const membership = project.members?.find((member) => String(member.user?._id || member.user) === String(memberId));
  if (!membership) throw new ProjectMembershipError('Member not found in this project.', 404);
  return { user: memberId, previousRole: membership.role || 'viewer', role };
}

export function prepareMemberRemoval(project, memberId) {
  if (String(memberId) === String(project.owner)) throw new ProjectMembershipError('The project owner cannot be removed.', 400);
  const membership = project.members?.find((member) => String(member.user?._id || member.user) === String(memberId));
  if (!membership) throw new ProjectMembershipError('Member not found in this project.', 404);
  return { user: memberId, role: membership.role || 'viewer' };
}
