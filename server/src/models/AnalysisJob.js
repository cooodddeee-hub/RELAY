import mongoose from 'mongoose';

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
  leaseToken: { type: String, select: false },
  leaseExpiresAt: { type: Date, select: false },
  startedAt: Date,
  completedAt: Date,
  lastProgressAt: Date,
}, { timestamps: true });

schema.index({ project: 1, createdAt: -1 });

export default mongoose.model('AnalysisJob', schema);
