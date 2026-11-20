import mongoose from 'mongoose';

const githubRepositorySchema = new mongoose.Schema({
  repositoryId: { type: String, maxlength: 24, immutable: true },
  fullName: { type: String, maxlength: 300, immutable: true },
}, { _id: false, id: false });

const schema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', immutable: true },
  action: { type: String, required: true, maxlength: 120, immutable: true },
  targetType: { type: String, required: true, maxlength: 100, immutable: true },
  targetId: { type: mongoose.Schema.Types.ObjectId, immutable: true },
  scopeType: { type: String, enum: ['project', 'category', 'handover'], default: 'project', immutable: true },
  scopeValue: { type: String, maxlength: 200, immutable: true },
  reason: { type: String, maxlength: 2000, immutable: true },
  comment: { type: String, maxlength: 5000, immutable: true },
  requestId: { type: String, maxlength: 200, immutable: true },
  policyVersion: { type: String, maxlength: 100, immutable: true },
  githubRepository: { type: githubRepositorySchema, immutable: true },
  expiresAt: { type: Date, required: true, immutable: true },
  createdAt: { type: Date, required: true, default: Date.now, immutable: true },
}, { timestamps: false });

schema.index({ projectId: 1, createdAt: -1 });
schema.index({ targetType: 1, targetId: 1, createdAt: 1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('AuditEvent', schema);
