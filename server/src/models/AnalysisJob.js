import mongoose from 'mongoose';

const providerAttemptSchema = new mongoose.Schema({
  provider: { type: String, enum: ['gemini', 'cloudflare'], required: true },
  role: { type: String, enum: ['primary', 'secondary'] },
  outcome: { type: String, enum: ['success', 'temporary_failure', 'permanent_failure', 'invalid_output', 'configuration_failure'], required: true },
  status: { type: Number, min: 100, max: 599 },
  category: { type: String, enum: ['success', 'timeout', 'http', 'network', 'configuration', 'invalid_output', 'unknown'] },
  errorCode: { type: String, enum: ['none', 'timeout', 'http_error', 'network_error', 'connection_error', 'configuration_error', 'invalid_output', 'unknown'] },
}, { _id: false });

const sourceRevisionSnapshotSchema = new mongoose.Schema({
  source: { type: mongoose.Schema.Types.ObjectId, ref: 'Source', required: true },
  revision: { type: mongoose.Schema.Types.ObjectId, ref: 'SourceRevision', required: true },
  revisionKey: { type: String, required: true, immutable: true, maxlength: 500 },
}, { _id: false, immutable: true });

const quoteMatchDiagnosticsSchema = new mongoose.Schema({
  exactQuoteMatch: { type: Boolean, required: true },
  caseOnlyMatch: { type: Boolean, required: true },
  punctuationOnlyMatch: { type: Boolean, required: true },
  unicodeNormalizationMatch: { type: Boolean, required: true },
}, { _id: false, strict: true });

const validationFailureSchema = new mongoose.Schema({
  provider: { type: String, enum: ['gemini', 'cloudflare'], required: true },
  sourceType: { type: String, enum: ['upload', 'readme', 'commit', 'issue', 'github_other'] },
  sourceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Source' },
  sourcePosition: { type: Number, min: 1, max: 500 },
  validationStage: { type: String, enum: ['provider_envelope', 'model_json', 'findings_array', 'finding_schema', 'evidence_reference', 'evidence_verification'], required: true },
  failureCode: { type: String, enum: ['invalid_json', 'invalid_response_envelope', 'missing_findings_array', 'invalid_finding_schema', 'missing_evidence', 'evidence_quote_mismatch', 'unsupported_evidence_reference', 'incomplete_provider_response'], required: true },
  quoteMatchDiagnostics: { type: quoteMatchDiagnosticsSchema, default: undefined },
}, { _id: false, strict: true });

const schema = new mongoose.Schema({
  project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sourceIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Source', required: true }],
  sourceRevisionSnapshots: { type: [sourceRevisionSnapshotSchema], default: undefined, immutable: true },
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
  lastValidationFailure: { type: validationFailureSchema, default: undefined },
  leaseToken: { type: String, select: false },
  leaseExpiresAt: { type: Date, select: false },
  startedAt: Date,
  completedAt: Date,
  lastProgressAt: Date,
}, { timestamps: true });

schema.index({ project: 1, createdAt: -1 });

schema.pre('save', async function preventRevisionSnapshotChange() {
  if (this.isNew) return;
  const existing = await this.constructor.findById(this._id).select('sourceRevisionSnapshots').lean();
  if (!existing) return;
  const normalize = (snapshots = []) => snapshots.map((item) => ({
    source: String(item.source), revision: String(item.revision), revisionKey: item.revisionKey,
  }));
  if (JSON.stringify(normalize(existing.sourceRevisionSnapshots)) !== JSON.stringify(normalize(this.sourceRevisionSnapshots))) {
    throw new Error('Analysis source revision snapshots are immutable after job creation.');
  }
});

schema.pre(['findOneAndUpdate', 'updateOne', 'updateMany', 'replaceOne'], function preventRevisionSnapshotUpdate(next) {
  const update = this.getUpdate() || {};
  if (Array.isArray(update)) return next(new Error('Analysis source revision snapshots are immutable after job creation.'));
  const keys = Object.keys(update).flatMap((key) => key.startsWith('$') && update[key] && typeof update[key] === 'object'
    ? Object.keys(update[key]) : [key]);
  if (keys.some((key) => key === 'sourceRevisionSnapshots' || key.startsWith('sourceRevisionSnapshots.'))) {
    return next(new Error('Analysis source revision snapshots are immutable after job creation.'));
  }
  return next();
});

export default mongoose.model('AnalysisJob', schema);
