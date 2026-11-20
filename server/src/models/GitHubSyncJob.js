import mongoose from 'mongoose';

export const GITHUB_SYNC_DEADLINE_MS = 45_000;
export const GITHUB_SYNC_LEASE_GRACE_MS = 15_000;

const categoryCheckpointSchema = new mongoose.Schema({
  status: {
    type: String,
    enum: ['pending', 'running', 'completed', 'skipped', 'failed'],
    default: 'pending',
  },
  page: { type: Number, min: 0, default: 0 },
  pagesScanned: { type: Number, min: 0, default: 0 },
  rawEntriesScanned: { type: Number, min: 0, default: 0 },
  itemsFetched: { type: Number, min: 0, default: 0 },
  sourcesCreated: { type: Number, min: 0, default: 0 },
  revisionsCreated: { type: Number, min: 0, default: 0 },
  revisionsReused: { type: Number, min: 0, default: 0 },
  partialReason: { type: String, maxlength: 80, match: /^[a-z0-9_]+$/ },
  contentBytes: { type: Number, min: 0, default: 0 },
  lastCompletedBatch: { type: Number, min: 0, default: 0 },
  updatedAt: Date,
}, { _id: false });

const countsSchema = new mongoose.Schema({
  responsesRead: { type: Number, min: 0, default: 0 },
  rawResponseBytes: { type: Number, min: 0, default: 0 },
  contentBytes: { type: Number, min: 0, default: 0 },
  commitsCaptured: { type: Number, min: 0, default: 0 },
  issuesCaptured: { type: Number, min: 0, default: 0 },
  pullRequestsSkipped: { type: Number, min: 0, default: 0 },
  sourcesCreated: { type: Number, min: 0, default: 0 },
  revisionsCreated: { type: Number, min: 0, default: 0 },
  revisionsReused: { type: Number, min: 0, default: 0 },
}, { _id: false });

const schema = new mongoose.Schema({
  project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true, immutable: true },
  repositoryLink: { type: mongoose.Schema.Types.ObjectId, ref: 'ProjectRepository', required: true, immutable: true },
  installation: { type: mongoose.Schema.Types.ObjectId, ref: 'GitHubInstallation', required: true, immutable: true },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  status: {
    type: String,
    enum: ['running', 'partial', 'retry_wait', 'completed', 'failed'],
    default: 'running',
    required: true,
  },
  resultCompleteness: { type: String, enum: ['complete', 'partial'], default: 'complete' },
  stage: {
    type: String,
    enum: ['refresh_installation', 'readme', 'commits', 'issues', 'finalize'],
    default: 'refresh_installation',
    required: true,
  },
  active: { type: Boolean, default: true, required: true },
  checkpoints: {
    readme: { type: categoryCheckpointSchema, default: () => ({}) },
    commits: { type: categoryCheckpointSchema, default: () => ({}) },
    issues: { type: categoryCheckpointSchema, default: () => ({}) },
  },
  counts: { type: countsSchema, default: () => ({}) },
  attemptCount: { type: Number, min: 0, default: 0 },
  retryable: { type: Boolean, default: false },
  retryAt: Date,
  lastErrorCode: { type: String, maxlength: 80, match: /^[A-Z0-9_]+$/ },
  lastErrorStatus: { type: Number, min: 400, max: 599 },
  startedAt: { type: Date, default: Date.now, required: true },
  deadlineAt: {
    type: Date,
    default: () => new Date(Date.now() + GITHUB_SYNC_DEADLINE_MS),
    required: true,
  },
  completedAt: Date,
  lastProgressAt: { type: Date, default: Date.now },
  leaseToken: { type: String, select: false },
  leaseExpiresAt: {
    type: Date,
    default: () => new Date(Date.now() + GITHUB_SYNC_DEADLINE_MS + GITHUB_SYNC_LEASE_GRACE_MS),
    select: false,
  },
}, { timestamps: true });

schema.pre('validate', function validateActiveState(next) {
  const isTerminal = ['completed', 'failed'].includes(this.status);
  if (this.active === isTerminal) {
    this.invalidate('active', 'Only nonterminal GitHub sync jobs may hold the active repository lock.');
  }
  next();
});

schema.index(
  { repositoryLink: 1, active: 1 },
  {
    unique: true,
    name: 'one_active_github_sync_per_repository_link',
    partialFilterExpression: { active: true },
  },
);
schema.index({ project: 1, createdAt: -1 });
schema.index({ repositoryLink: 1, createdAt: -1 });

schema.statics.createOrGetActive = async function createOrGetActive({ repositoryLink, ...jobFields }) {
  const filter = { repositoryLink, active: true };
  const existing = await this.findOne(filter);
  if (existing) return { job: existing, created: false };

  try {
    const [job] = await this.create([{ ...jobFields, repositoryLink, active: true }]);
    return { job, created: true };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const winner = await this.findOne(filter);
    if (!winner) throw error;
    return { job: winner, created: false };
  }
};

export default mongoose.model('GitHubSyncJob', schema);
