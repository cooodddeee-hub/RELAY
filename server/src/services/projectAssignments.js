import mongoose from 'mongoose';
import ProjectAssignment from '../models/ProjectAssignment.js';
import { projectRole } from './projectPermissions.js';

export const ASSIGNMENT_ROLES = ['reviewer', 'approver', 'audit_reader'];
export const ASSIGNMENT_SCOPE_TYPES = ['project', 'category', 'handover'];
export const FINDING_CATEGORIES = [
  'Decision', 'Completed Work', 'Pending Tasks', 'Responsibilities', 'Blockers',
  'Dependencies', 'Risks', 'Next Actions', 'Unresolved Questions',
];

export class ProjectAssignmentError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'ProjectAssignmentError'; this.status = status; }
}

export function normalizeAssignmentInput(input = {}) {
  const role = input.role;
  const scopeType = input.scopeType || 'project';
  const scopeValue = typeof input.scopeValue === 'string' ? input.scopeValue.trim() : '';
  if (!ASSIGNMENT_ROLES.includes(role)) throw new ProjectAssignmentError('Choose reviewer, approver, or audit_reader.');
  if (!ASSIGNMENT_SCOPE_TYPES.includes(scopeType)) throw new ProjectAssignmentError('Choose a valid assignment scope.');
  if (scopeType === 'project' && scopeValue) throw new ProjectAssignmentError('Project-wide assignments do not take a scope value.');
  if (scopeType === 'category' && !FINDING_CATEGORIES.includes(scopeValue)) throw new ProjectAssignmentError('Choose a valid finding category for this assignment.');
  if (scopeType === 'handover' && !/^[a-f\d]{24}$/i.test(scopeValue)) throw new ProjectAssignmentError('A valid handover ID is required for this scope.');
  return { role, scopeType, scopeValue };
}

export function isCurrentProjectMember(project, userId) {
  return Boolean(projectRole(project, userId));
}

export function assignmentScopeQuery({ projectId, userId, role, category, handoverId }) {
  const query = { project: projectId, user: userId, role, status: 'active' };
  const scopes = [{ scopeType: 'project' }];
  if (category) scopes.push({ scopeType: 'category', scopeValue: category });
  if (handoverId) scopes.push({ scopeType: 'handover', scopeValue: String(handoverId) });
  query.$or = scopes;
  return query;
}

/**
 * Claim the matching reviewer assignment inside the review transaction. The
 * conditional write serializes a review against a concurrent revocation, so a
 * committed revocation cannot silently race an already-authorized review.
 */
export async function claimReviewerAssignment({ projectId, userId, category, session }) {
  if (!mongoose.isValidObjectId(projectId) || !mongoose.isValidObjectId(userId)) return null;
  return ProjectAssignment.findOneAndUpdate(
    assignmentScopeQuery({ projectId, userId, role: 'reviewer', category }),
    { $inc: { authorizationUseCount: 1 } },
    { new: true, session },
  ).select('+authorizationUseCount').lean();
}

export async function claimApproverAssignment({ projectId, userId, handoverId, session }) {
  if (!mongoose.isValidObjectId(projectId) || !mongoose.isValidObjectId(userId) || !mongoose.isValidObjectId(handoverId)) return null;
  return ProjectAssignment.findOneAndUpdate(
    assignmentScopeQuery({ projectId, userId, role: 'approver', handoverId }),
    { $inc: { authorizationUseCount: 1 } },
    { new: true, session },
  ).select('+authorizationUseCount').lean();
}

export async function canReadAuditEvents(project, userId, { session } = {}) {
  if (String(project.owner) === String(userId)) return { allowed: true, query: { projectId: project._id } };
  if (!isCurrentProjectMember(project, userId)) return { allowed: false, query: null };
  let assignments = ProjectAssignment.find({ project: project._id, user: userId, role: 'audit_reader', status: 'active' })
    .select('scopeType scopeValue').lean();
  if (session) assignments = assignments.session(session);
  const scopes = await assignments;
  if (!scopes.length) return { allowed: false, query: null };
  const projectWide = scopes.some((item) => item.scopeType === 'project');
  const query = { projectId: project._id };
  if (!projectWide) {
    query.$or = scopes.map((item) => ({ scopeType: item.scopeType, scopeValue: item.scopeValue }));
  }
  return { allowed: true, query };
}

export function canReviewFinding(project, userId, finding, assignments = []) {
  if (!isCurrentProjectMember(project, userId)) return false;
  if (project.workflowPolicy?.reviewMode !== 'assigned') {
    const role = projectRole(project, userId);
    return role === 'owner' || role === 'editor';
  }
  if (!finding || !FINDING_CATEGORIES.includes(finding.category)) return false;
  return assignments.some((assignment) => isReviewerScopeMatch(assignment, finding));
}

export function isReviewerScopeMatch(assignment, finding) {
  if (!assignment || assignment.role !== 'reviewer' || assignment.status !== 'active') return false;
  if (assignment.scopeType === 'project') return true;
  return assignment.scopeType === 'category' && assignment.scopeValue === finding?.category;
}
