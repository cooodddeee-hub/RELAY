# Round 3 Phase 2 Migration: Active Assignment Index

This migration creates the partial unique assignment index on `{ project, user, role, scopeType, scopeValue }` where `status: active`. Revoked history is preserved. It counts duplicate active assignments before any index operation and refuses conflicting index definitions.

## Target and confirmation

Run from `server/`. Required environment names: `MONGODB_URI`, `PHASE2_MIGRATION_EXPECT_DATABASE`, and `PHASE2_MIGRATION_CONFIRM_TARGET`. Exact token format:

```text
APPLY_PHASE2_ACTIVE_ASSIGNMENT_INDEX:<database-name>
```

Before connecting, the script validates the MongoDB URI, one non-reserved database in its path, a matching optional `dbName` override, exact expected database, and exact migration/target token. It uses that same validated URI for connection. Dry-run also requires the target/token checks.

## Commands

Provide the three variables through a protected operator environment (the script loads `server/.env` if present; do not store production credentials in the repository). `<database-name>` is a placeholder:

```sh
cd server
node scripts/migrations/phase2-active-assignment-index.js --dry-run
node scripts/migrations/phase2-active-assignment-index.js
node scripts/migrations/phase5-production-model-indexes.js --verify-only
```

Dry-run is read-only and reports duplicate active keys and index changes. The write command is idempotent and refuses unresolved duplicates. The final Phase 5 command verifies every currently declared model index and is also target-confirmed; it performs no writes. See [the database migration runbook](DATABASE_MIGRATION_RUNBOOK.md).

Projects need no policy backfill: missing review/signoff modes retain legacy behavior; new projects default to assigned workflows. The migration has been tested only against the isolated replica set, not production/shared data. Resolve duplicates manually through an approved data decision and preserve revoked assignment history.
