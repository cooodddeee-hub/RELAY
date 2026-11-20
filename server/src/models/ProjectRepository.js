import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
  installation: { type: mongoose.Schema.Types.ObjectId, ref: 'GitHubInstallation', required: true },
  repositoryId: { type: String, required: true },
  ownerLogin: { type: String, required: true },
  name: { type: String, required: true },
  fullName: { type: String, required: true },
  htmlUrl: { type: String, required: true },
  defaultBranch: String,
  linkedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['active', 'unlinked'], default: 'active', required: true },
  unlinkedAt: Date,
  unlinkedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

schema.index(
  { project: 1, repositoryId: 1, status: 1 },
  { unique: true, name: 'active_project_repository_unique', partialFilterExpression: { status: 'active' } },
);
schema.index({ installation: 1, repositoryId: 1, status: 1 });
schema.index({ project: 1, status: 1, createdAt: -1 });

export default mongoose.model('ProjectRepository', schema);
