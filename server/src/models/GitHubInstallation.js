import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  installationId: { type: String, required: true, immutable: true },
  accountId: { type: String, required: true },
  accountLogin: { type: String, required: true },
  accountType: { type: String, enum: ['User', 'Organization', 'Bot'], required: true },
  installedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  authorizedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  status: { type: String, enum: ['active', 'suspended', 'removed'], default: 'active' },
  grantedPermissions: { type: mongoose.Schema.Types.Mixed, default: {} },
  lastVerifiedAt: Date,
}, { timestamps: true });

schema.index({ installationId:  1 }, { unique: true });
schema.index({ authorizedUsers: 1, status: 1 });

export default mongoose.model('GitHubInstallation', schema);
