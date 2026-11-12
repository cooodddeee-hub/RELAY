import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  finding: { type: mongoose.Schema.Types.ObjectId, ref: 'Finding', required: true, index: true },
  project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  reviewer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  action: { type: String, enum: ['approved', 'rejected', 'clarification_requested', 'edited', 'returned_to_pending', 'reopened'], required: true },
  previousValues: { type: mongoose.Schema.Types.Mixed, default: undefined },
  updatedValues: { type: mongoose.Schema.Types.Mixed, default: undefined },
  reason: { type: String, maxlength: 2000 },
  comment: { type: String, maxlength: 2000 },
}, { timestamps: true });

schema.index({ finding: 1, createdAt: 1 });
export default mongoose.model('ReviewHistory', schema);
