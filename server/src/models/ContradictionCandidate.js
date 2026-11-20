import mongoose from 'mongoose';

const evidenceSchema = new mongoose.Schema({
  source: { type: mongoose.Schema.Types.ObjectId, ref: 'Source', required: true },
  sourceRevision: { type: mongoose.Schema.Types.ObjectId, ref: 'SourceRevision', required: true },
  quote: { type: String, required: true, maxlength: 5000 },
  matchedText: { type: String, maxlength: 5000 },
  startOffset: Number,
  endOffset: Number,
  locator: mongoose.Schema.Types.Mixed,
  sourceUpdatedAt: Date,
}, { _id: false, immutable: true });

const claimSchema = new mongoose.Schema({
  summary: { type: String, required: true, maxlength: 2000, immutable: true },
  finding: { type: mongoose.Schema.Types.ObjectId, ref: 'Finding', immutable: true },
  category: { type: String, maxlength: 100, immutable: true },
  effectiveAt: { type: Date, immutable: true },
}, { _id: false, immutable: true });
const schema = new mongoose.Schema({
  project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true, immutable: true },
  candidateKey: { type: String, required: true, maxlength: 500, immutable: true },
  claims: { type: [claimSchema], required: true, immutable: true, validate: (items) => items.length >= 2 },
  evidence: {
    type: [evidenceSchema], required: true, immutable: true,
    validate: (items) => items.length >= 2 && new Set(items.map((item) => String(item.sourceRevision))).size >= 2,
  },
  relationship: { type: String, enum: ['possible_conflict', 'possible_supersession'], required: true, immutable: true },
  cautiousLabel: { type: String, enum: ['needs_human_check', 'possible_conflict', 'likely_stale'], required: true, immutable: true },
  confidenceBand: { type: String, enum: ['low', 'medium', 'high'], required: true, immutable: true },
  confidence: { type: Number, min: 0, max: 1, immutable: true },
  explanation: { type: String, required: true, maxlength: 5000, immutable: true },
  modelProvider: { type: String, maxlength: 100, immutable: true },
  modelName: { type: String, maxlength: 200, immutable: true },
  promptVersion: { type: String, maxlength: 100, immutable: true },
  status: { type: String, enum: ['candidate', 'in_review', 'confirmed_conflict', 'stale_information', 'resolved', 'dismissed'], default: 'candidate', required: true },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: Date,
  reviewReason: { type: String, maxlength: 2000 },
}, { timestamps: true });

schema.index({ project: 1, candidateKey: 1 }, { unique: true });
schema.index({ project: 1, status: 1, createdAt: -1 });
schema.index({ 'evidence.sourceRevision': 1 });

export default mongoose.model('ContradictionCandidate', schema);
