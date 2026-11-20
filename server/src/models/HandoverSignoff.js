import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true, immutable: true },
  handover: { type: mongoose.Schema.Types.ObjectId, ref: 'Handover', required: true, immutable: true },
  version: { type: Number, required: true, min: 1, immutable: true },
  signer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  assignment: { type: mongoose.Schema.Types.ObjectId, ref: 'ProjectAssignment', required: true, immutable: true },
  decision: { type: String, enum: ['approved', 'rejected'], required: true, immutable: true },
  reason: { type: String, required: function requiredForRejection() { return this.decision === 'rejected'; }, maxlength: 2000, immutable: true },
  comment: { type: String, required: true, minlength: 1, maxlength: 5000, immutable: true },
  expiresAt: { type: Date, required: true, immutable: true },
  createdAt: { type: Date, required: true, default: Date.now, immutable: true },
}, { timestamps: false });

schema.index({ handover: 1, signer: 1 }, { unique: true });
schema.index({ project: 1, handover: 1, version: 1, createdAt: 1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('HandoverSignoff', schema);
