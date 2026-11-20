import mongoose from 'mongoose';

const workflowPolicySchema = new mongoose.Schema({
  reviewMode: { type: String, enum: ['legacy_editors', 'assigned'], default: 'legacy_editors' },
  signoffMode: { type: String, enum: ['none', 'assigned'], default: 'none' },
}, { _id: false });

const schema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  members: [{
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    role: { type: String, enum: ['owner', 'editor', 'viewer'], default: 'viewer' },
  }],
  status: { type: String, enum: ['active', 'review', 'completed'], default: 'active' },
  workflowPolicy: { type: workflowPolicySchema, default: () => ({}) },
  handoverVersionCounter: { type: Number, min: 0, select: false },
  signoffLockCounter: { type: Number, min: 0, default: 0, select: false },
  deletionGuardVersion: { type: Number, min: 0, default: 0, select: false },
  githubAuthorizationVersion: { type: Number, min: 0, default: 0, select: false },
  deletionState: { type: String, enum: ['active', 'queued', 'purging', 'blocked', 'complete'], default: 'active' },
  deletionRequestedAt: Date,
  deletedAt: Date,
  deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  activeAnalysisJob: { type: mongoose.Schema.Types.ObjectId, ref: 'AnalysisJob', select: false },
  analysisLockToken: { type: String, select: false },
  analysisLockExpiresAt: { type: Date, select: false },
  handoverLockToken: { type: String, select: false },
  handoverLockExpiresAt: { type: Date, select: false },
}, { timestamps: true });

export default mongoose.model('Project', schema);
