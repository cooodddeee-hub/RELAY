# Phase 4A Index Migration

Phase 4A adds unique indexes for GitHub source identity, immutable source revision identity, and one active sync job per repository link. The migration performs duplicate preflight before creating any index. It creates indexes only; it does not insert, update, or delete Source, SourceRevision, or GitHubSyncJob records.

## Required target confirmation

The script requires all of these server-side environment variable names:

- `MONGODB_URI`
- `PHASE4_MIGRATION_EXPECT_DATABASE`
- `PHASE4_MIGRATION_CONFIRM_TARGET`

The expected database must exactly match the database path in the MongoDB URI. The confirmation value must be exactly:

```text
APPLY_PHASE4_GITHUB_SYNC_INDEXES:<database-name>
```

The script rejects an empty/reserved database, mismatched name, missing exact confirmation, non-MongoDB URI, or conflicting `dbName` override. It does not print the URI or connection details. Do not place credential values in command history or logs.

## Run and test policy

The script is `server/scripts/migrations/phase4-github-sync-indexes.js`. It was run twice only by an integration test targeting the isolated `127.0.0.1:27018/relay_round3_test` replica set. It has not been run against production or shared databases.

Before any deployment migration, back up the target, inspect duplicate preflight results in a disposable copy, verify the exact Vercel/application database target, and use the approved maintenance process. A duplicate preflight aborts before index creation. Resolve duplicates only through an explicitly reviewed data-repair decision; this migration never chooses or deletes historical source/revision records.

The migration is idempotent for an already-correct index set. Existing model indexes may already be present; MongoDB treats creation of the same named key/options as a no-op.

Phase 5 now contains the full declared Mongoose model index manifest, including all Phase 1–4 constraints and TTL indexes. Use its target-confirmed `--verify-only` mode after the ordered migrations; production `autoIndex` is disabled. See the [complete database migration runbook](DATABASE_MIGRATION_RUNBOOK.md).
