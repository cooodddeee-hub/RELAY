const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,63}$/;
const RESERVED_DATABASE_NAMES = new Set(['admin', 'config', 'local']);

export function validateMigrationTarget({ uri, expectedDatabase, confirmation, migrationId }) {
  if (typeof uri !== 'string' || !uri.trim()) {
    throw new Error('MONGODB_URI is required for this database migration.');
  }
  let parsed;
  try { parsed = new URL(uri); } catch {
    throw new Error('MONGODB_URI is invalid; connection details are suppressed.');
  }
  if (!['mongodb:', 'mongodb+srv:'].includes(parsed.protocol)) {
    throw new Error('Database migrations accept only MongoDB connection URIs.');
  }
  let databaseName;
  try { databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, '')); } catch {
    throw new Error('MONGODB_URI must include one valid database name.');
  }
  if (!DATABASE_NAME_PATTERN.test(databaseName) || RESERVED_DATABASE_NAMES.has(databaseName)) {
    throw new Error('MONGODB_URI must target a named application database.');
  }
  if (parsed.searchParams.getAll('dbName').length > 1) {
    throw new Error('MONGODB_URI must specify at most one database override.');
  }
  const override = parsed.searchParams.get('dbName');
  if (parsed.hash || (override !== null && override !== databaseName)) {
    throw new Error('MONGODB_URI database path and dbName override must identify the same database.');
  }
  if (typeof expectedDatabase !== 'string' || expectedDatabase !== databaseName) {
    throw new Error('Expected migration database must exactly match the database in MONGODB_URI.');
  }
  if (typeof migrationId !== 'string' || !/^[A-Z0-9_]+$/.test(migrationId)) {
    throw new TypeError('A valid migration identifier is required.');
  }
  if (confirmation !== `APPLY_${migrationId}:${databaseName}`) {
    throw new Error('Migration confirmation must explicitly confirm this migration and exact target database.');
  }
  return { databaseName, uri };
}

export function validatePhase4MigrationTarget({ uri, expectedDatabase, confirmation }) {
  return validateMigrationTarget({
    uri,
    expectedDatabase,
    confirmation,
    migrationId: 'PHASE4_GITHUB_SYNC_INDEXES',
  });
}

export async function countDuplicateKeys(collection, { fields, filter }) {
  if (!Array.isArray(fields) || fields.length === 0) throw new TypeError('Duplicate preflight fields are required.');
  const key = Object.fromEntries(fields.map((field) => [field, `$${field}`]));
  const pipeline = [
    ...(filter ? [{ $match: filter }] : []),
    { $group: { _id: key, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $group: {
      _id: null,
      duplicateKeyCount: { $sum: 1 },
      duplicateRecordCount: { $sum: '$count' },
      extraRecordCount: { $sum: { $subtract: ['$count', 1] } },
    } },
  ];
  const duplicates = await collection.aggregate(pipeline).toArray();
  return duplicates[0]
    ? { duplicateKeyCount: duplicates[0].duplicateKeyCount, duplicateRecordCount: duplicates[0].duplicateRecordCount, extraRecordCount: duplicates[0].extraRecordCount }
    : { duplicateKeyCount: 0, duplicateRecordCount: 0, extraRecordCount: 0 };
}

export async function assertNoDuplicateKeys(collection, { fields, filter, description }) {
  const summary = await countDuplicateKeys(collection, { fields, filter });
  if (summary.duplicateKeyCount) {
    const error = new Error(`Duplicate ${description} records must be resolved before index creation (${summary.duplicateKeyCount} duplicate keys).`);
    error.code = 'PHASE4_MIGRATION_DUPLICATES';
    error.duplicateSummary = summary;
    throw error;
  }
  return summary;
}

export async function readIndexes(collection) {
  if (typeof collection.indexes !== 'function') return [];
  try { return await collection.indexes(); }
  catch (error) {
    if (error?.code === 26 || error?.codeName === 'NamespaceNotFound') return [];
    throw error;
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function planIndexChanges(existingIndexes, desiredIndexes, { drop = [] } = {}) {
  const indexesToCreate = [];
  const indexesToChange = [];
  const indexesToDrop = [];
  const isDropped = (index) => drop.some((predicate) => predicate(index));
  for (const index of existingIndexes) {
    if (isDropped(index)) indexesToDrop.push({ name: index.name, key: index.key });
  }
  for (const desired of desiredIndexes) {
    const desiredName = desired.options.name;
    const equivalent = existingIndexes.find((existing) => !isDropped(existing)
      && stableJson(existing.key) === stableJson(desired.keys)
      && Boolean(existing.unique) === Boolean(desired.options.unique)
      && Boolean(existing.sparse) === Boolean(desired.options.sparse)
      && stableJson(existing.partialFilterExpression || null) === stableJson(desired.options.partialFilterExpression || null)
      && (existing.expireAfterSeconds ?? null) === (desired.options.expireAfterSeconds ?? null));
    if (equivalent) continue;

    const conflict = existingIndexes.find((existing) => !isDropped(existing)
      && (existing.name === desiredName || stableJson(existing.key) === stableJson(desired.keys)));
    if (conflict) {
      indexesToChange.push({
        existing: { name: conflict.name, key: conflict.key, unique: Boolean(conflict.unique), sparse: Boolean(conflict.sparse), partialFilterExpression: conflict.partialFilterExpression },
        desired: { name: desiredName, key: desired.keys, unique: Boolean(desired.options.unique), sparse: Boolean(desired.options.sparse), partialFilterExpression: desired.options.partialFilterExpression },
      });
    } else indexesToCreate.push({ name: desiredName, key: desired.keys, unique: Boolean(desired.options.unique), sparse: Boolean(desired.options.sparse), partialFilterExpression: desired.options.partialFilterExpression });
  }
  return { indexesToCreate, indexesToChange, indexesToDrop };
}

export function createDuplicatePreflightError(duplicateSummaries) {
  const conflicts = Object.entries(duplicateSummaries).filter(([, summary]) => summary.duplicateKeyCount > 0);
  if (!conflicts.length) return null;
  const error = new Error(`Duplicate records must be resolved before migration (${conflicts.map(([name, summary]) => `${name}: ${summary.duplicateKeyCount} keys`).join('; ')}).`);
  error.code = 'MIGRATION_DUPLICATES';
  error.duplicateSummaries = duplicateSummaries;
  return error;
}
