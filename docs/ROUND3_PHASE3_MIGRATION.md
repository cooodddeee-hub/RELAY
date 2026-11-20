# Phase 3 Repository Soft-Unlink Migration

This migration backfills missing `ProjectRepository.status` values to `active`, creates the partial unique active-link index, and drops the old global unique `{ project, repositoryId }` index. Existing repository links and provenance records are retained. The migration checks duplicate active-or-legacy links before any collection/index/data mutation.

## Target and confirmations

Run from `server/`. Required variables are `MONGODB_URI`, `PHASE3_MIGRATION_EXPECT_DATABASE`, and `PHASE3_MIGRATION_CONFIRM_TARGET`. The exact primary token is:

```text
APPLY_PHASE3_REPOSITORY_SOFT_UNLINK_INDEX:<database-name>
```

The write additionally requires `PHASE3_MIGRATION_CONFIRM_CHANGES` with this exact value:

```text
APPLY_PHASE3_REPOSITORY_SOFT_UNLINK_CHANGES:<database-name>
```

Before connecting, the script validates that the MongoDB URI contains one non-reserved application database, any `dbName` override agrees with the URI path, the expected database exactly matches, and the primary token exactly confirms the phase and target. It connects with the exact URI that passed validation. `--dry-run` requires primary target confirmation but not the structural-change confirmation because it performs no writes.

## Commands

Supply variables via a protected operator environment; use the same target placeholder in the URI path, expected database, and token values. The script loads `server/.env` if present; never commit production credentials.

```sh
cd server
node scripts/migrations/phase3-repository-soft-unlink-index.js --dry-run
node scripts/migrations/phase3-repository-soft-unlink-index.js
node scripts/migrations/phase5-production-model-indexes.js --verify-only
```

The dry-run reports duplicate active/legacy pairs, legacy rows to activate, and indexes to create/change/drop; it performs zero writes. For the apply command set both exact confirmation variables. Duplicate or conflicting definitions abort before mutation. The apply is idempotent. Phase 5's target-confirmed verification-only command checks the full declared model-index inventory without writes. See [the database migration runbook](DATABASE_MIGRATION_RUNBOOK.md).

This has been exercised only against the isolated test replica set. It has not been run against production/shared data. Review a verified backup and restore procedure first. Never automatically delete historical repository links or source/revision records to resolve duplicate data.
