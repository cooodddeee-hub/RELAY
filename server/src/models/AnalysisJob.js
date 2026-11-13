import mongoose from 'mongoose';

const providerAttemptSchema = new mongoose.Schema({
  provider: { type: String, enum: ['gemini', 'cloudflare'], required: true },
  outcome: { type: String, enum: ['temporary_failure', 'permanent_failure', 'invalid_output', 'configuration_failure'], required: true },
}, { _id: false });

const schema = new mongoose.Schema({
  project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sourceIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Source', required: true }],
  nextSourceIndex: { type: Number, default: 0, min: 0 },
  completedSourceCount: { type: Number, default: 0, min: 0 },
  currentSource: { type: mongoose.Schema.Types.ObjectId, ref: 'Source', default: null },
  status: { type: String, enum: ['queued', 'running', 'retry_wait', 'completed', 'failed'], default: 'queued', index: true },
  stage: { type: String, enum: ['queued', 'analyzing_source', 'saving_findings', 'retry_wait', 'completed', 'failed'], default: 'queued' },
  attemptCount: { type: Number, default: 0, min: 0 },
  retryAt: Date,
  retryable: { type: Boolean, default: false },
  lastErrorKind: String,
  lastErrorStatus: Number,
  lastProviderAttempts: { type: [providerAttemptSchema], default: undefined },
  leaseToken: { type: String, select: false },
  leaseExpiresAt: { type: Date, select: false },
  startedAt: Date,
  completedAt: Date,
  lastProgressAt: Date,
}, { timestamps: true });

schema.index({ project: 1, createdAt: -1 });

export default mongoose.model('AnalysisJob', schema);
