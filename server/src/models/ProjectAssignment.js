import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  role: { type: String, enum: ['reviewer', 'approver', 'audit_reader'], required: true },
  scopeType: { type: String, enum: ['project', 'category', 'handover'], default: 'project', required: true },
  scopeValue: { type: String, default: '' },
  assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  assignedAt: { type: Date, required: true, default: Date.now },
  status: { type: String, enum: ['active', 'revoked'], default: 'active', required: true },
  revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  revokedAt: Date,
  revokeReason: { type: String, maxlength: 1000 },
  authorizationUseCount: { type: Number, min: 0, default: 0, select: false },
}, { timestamps: true });

schema.index({ project: 1, user: 1, role: 1, scopeType: 1, scopeValue: 1, status: 1 });
schema.index(
  { project: 1, user: 1, role: 1, scopeType: 1, scopeValue: 1 },
  { unique: true, name: 'active_assignment_unique', partialFilterExpression: { status: 'active' } },
);

export default mongoose.model('ProjectAssignment', schema);
