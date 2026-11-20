import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  source: { type: mongoose.Schema.Types.ObjectId, ref: 'Source', required: true, immutable: true },
  revisionKey: { type: String, required: true, immutable: true, maxlength: 500 },
  contentHash: { type: String, required: true, immutable: true, maxlength: 128 },
  textSnapshot: { type: String, required: true, immutable: true },
  providerUpdatedAt: Date,
  capturedAt: { type: Date, required: true, default: Date.now, immutable: true },
  locator: { type: mongoose.Schema.Types.Mixed, immutable: true },
}, { timestamps: true });

schema.index({ source: 1, revisionKey: 1 }, { unique: true });
schema.index({ source: 1, capturedAt: -1 });

export default mongoose.model('SourceRevision', schema);
