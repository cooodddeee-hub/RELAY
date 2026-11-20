import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  requester: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  policyVersion: { type: String, required: true, immutable: true, maxlength: 100 },
  status: { type: String, enum: ['queued', 'running', 'retry_wait', 'blocked', 'complete'], default: 'queued', required: true },
  phase: { type: String, required: true, maxlength: 100 },
  cursor: { type: String, maxlength: 500 },
  attemptCount: { type: Number, min: 0, default: 0 },
  lastErrorCode: { type: String, maxlength: 120 },
  nextAttemptAt: Date,
  leaseToken: { type: String, select: false },
  leaseExpiresAt: { type: Date, select: false },
}, { timestamps: true });

schema.index({ projectId: 1 }, { unique: true });
schema.index({ status: 1, nextAttemptAt: 1 });
schema.index({ status: 1, leaseExpiresAt: 1 });

export default mongoose.model('ProjectDeletionJob', schema);
