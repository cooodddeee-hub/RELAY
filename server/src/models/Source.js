import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
  provider: { type: String, enum: ['upload', 'github'], default: 'upload' },
  externalType: { type: String, enum: ['repository', 'readme', 'commit', 'issue'] },
  repositoryLink: { type: mongoose.Schema.Types.ObjectId, ref: 'ProjectRepository' },
  externalId: String,
  externalUrl: String,
  externalUpdatedAt: Date,
  currentRevision: { type: mongoose.Schema.Types.ObjectId, ref: 'SourceRevision' },
  analyzedRevision: { type: mongoose.Schema.Types.ObjectId, ref: 'SourceRevision', select: false },
  originalName: { type: String, required: true },
  mimeType: String,
  size: Number,
  storageProvider: { type: String, enum: ['local', 'supabase'], default: 'local' },
  storageBucket: String,
  storageKey: String,
  storagePath: { type: String, required: false },
  uploadStatus: { type: String, enum: ['pending', 'processing', 'completed', 'failed', 'deleting'], default: 'completed' },
  uploadIntentExpiresAt: Date,
  extractedText: { type: String, default: '' },
  status: { type: String, enum: ['uploaded', 'processing', 'processed', 'failed'], default: 'uploaded' },
  analysisCompletedAt: { type: Date, select: false },
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  error: String,
}, { timestamps: true });

schema.index(
  { provider: 1, repositoryLink: 1, externalType: 1, externalId: 1 },
  {
    unique: true,
    partialFilterExpression: { provider: 'github', repositoryLink: { $exists: true }, externalId: { $exists: true } },
  },
);
schema.index({ project: 1, provider: 1, status: 1 });

export default mongoose.model('Source', schema);
