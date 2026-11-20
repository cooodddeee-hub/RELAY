import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  stateHash: { type: String, required: true, unique: true, immutable: true },
  project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true, immutable: true },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  purpose: { type: String, enum: ['setup', 'oauth', 'oauth_discovery'], default: 'setup', required: true, immutable: true },
  installationId: { type: String, immutable: true },
  expiresAt: { type: Date, required: true },
  consumedAt: Date,
}, { timestamps: true });

schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('GitHubInstallState', schema);
