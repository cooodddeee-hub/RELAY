import Project from '../models/Project.js';

const ACTIVE_PROJECT_FILTER = { $or: [{ deletionState: 'active' }, { deletionState: { $exists: false } }] };

export class ProjectWriteAuthorizationError extends Error {
  constructor(role) {
    super(`Current project ${role} permission is required.`);
    this.name = 'ProjectWriteAuthorizationError';
    this.status = 403;
    this.code = 'PROJECT_ROLE_CHANGED';
  }
}

/** Serialize an in-flight project write against deletion tombstoning. */
export async function claimActiveProjectWrite(projectId, session) {
  const result = await Project.updateOne(
    { _id: projectId, $or: [{ deletionState: 'active' }, { deletionState: { $exists: false } }] },
    { $inc: { deletionGuardVersion: 1 } },
    { session, timestamps: false },
  );
  if (!result.matchedCount) {
    const error = new Error('Project deletion has started; the operation was not saved.');
    error.status = 410;
    error.code = 'PROJECT_DELETION_IN_PROGRESS';
    throw error;
  }
  return result;
}

/**
 * Check and serialize a project write against role/membership changes.
 * This must be called from inside the transaction that performs the protected
 * write. The conditional update makes MongoDB retry the transaction if a
 * concurrent membership or ownership update wins first; every retry runs this
 * role predicate again against its new transaction snapshot.
 */
export async function claimProjectRoleWrite(projectId, actorId, requiredRole, session) {
  const actor = String(actorId);
  let roleFilter;
  if (requiredRole === 'owner') {
    roleFilter = { owner: actorId };
  } else if (requiredRole === 'editor') {
    roleFilter = { $or: [
      { owner: actorId },
      { members: { $elemMatch: { user: actorId, role: 'editor' } } },
    ] };
  } else if (requiredRole === 'member') {
    roleFilter = { $or: [
      { owner: actorId },
      { members: { $elemMatch: { user: actorId, role: { $in: ['owner', 'editor', 'viewer'] } } } },
    ] };
  } else {
    throw new TypeError('A supported project role is required.');
  }

  const result = await Project.updateOne(
    { $and: [{ _id: projectId, ...ACTIVE_PROJECT_FILTER }, roleFilter] },
    { $inc: { deletionGuardVersion: 1 } },
    { session, timestamps: false },
  );
  if (!result.matchedCount) {
    const current = await Project.findById(projectId).session(session).select('deletionState').lean();
    if (!current || (current.deletionState && current.deletionState !== 'active')) {
      const error = new Error('Project deletion has started; the operation was not saved.');
      error.status = current ? 410 : 404;
      error.code = current ? 'PROJECT_DELETION_IN_PROGRESS' : 'PROJECT_NOT_FOUND';
      throw error;
    }
    throw new ProjectWriteAuthorizationError(requiredRole);
  }

  const project = await Project.findOne({ _id: projectId, ...ACTIVE_PROJECT_FILTER }).session(session);
  if (!project) {
    const error = new Error('Project deletion has started; the operation was not saved.');
    error.status = 410;
    error.code = 'PROJECT_DELETION_IN_PROGRESS';
    throw error;
  }
  // Keep this explicit assertion next to the guarded update. It documents the
  // role contract and protects against a future filter/schema mismatch.
  const currentOwner = String(project.owner) === actor;
  const currentMembership = project.members?.find((member) => String(member.user?._id || member.user) === actor);
  const allowed = requiredRole === 'owner' ? currentOwner
    : requiredRole === 'editor' ? currentOwner || currentMembership?.role === 'editor'
      : currentOwner || ['owner', 'editor', 'viewer'].includes(currentMembership?.role);
  if (!allowed) throw new ProjectWriteAuthorizationError(requiredRole);
  return project;
}
