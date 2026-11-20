# Round 3 Phase 1 Migration: Handover Version Index

This migration creates the unique `{ project: 1, version: 1 }` handover index. It performs duplicate preflight first, is idempotent, and never deletes or rewrites handovers.

## Target and confirmation

Run from `server/`. Required environment names are `MONGODB_URI`, `PHASE1_MIGRATION_EXPECT_DATABASE`, and `PHASE1_MIGRATION_CONFIRM_TARGET`. The exact token format derived from the script is:

```text
APPLY_PHASE1_HANDOVER_VERSION_INDEX:<database-name>
```

Before the script calls MongoDB connect, it verifies that the URI is MongoDB, its path names one non-reserved database, any `dbName` override matches that path, the expected database exactly matches it, and the confirmation token matches the migration and database. The URI validated is the URI passed to `connect`. Dry-run requires the same target and confirmation values.

## Commands

Set values in a protected operator environment; do not put credentials in shell history. `<database-name>` is a placeholder and must be replaced consistently. The script loads `server/.env` with dotenv when present.

```sh
cd server
node scripts/migrations/phase1-handover-version-index.js --dry-run
node scripts/migrations/phase1-handover-version-index.js
```

The first command reports duplicate `{project, version}` keys and index create/change/drop plans without writes. It aborts if duplicates or a conflicting index exist. The second performs the idempotent create only after confirmation. After all migrations, verify the complete current model index inventory with Phase 5:

```sh
node scripts/migrations/phase5-production-model-indexes.js --verify-only
```

Phase 5 verification itself requires `MONGODB_URI`, `PHASE5_MIGRATION_EXPECT_DATABASE`, and `PHASE5_MIGRATION_CONFIRM_TARGET=APPLY_PHASE5_PRODUCTION_MODEL_INDEXES:<database-name>`; `--verify-only` is read-only. See [the database migration runbook](DATABASE_MIGRATION_RUNBOOK.md) for the ordered backup, preflight, write, and verification procedure.

The migration has only been exercised against the isolated test replica set, not production/shared data. Existing handovers remain intact. Resolve duplicates through a separately reviewed archival/renumbering decision; never let the migration choose or delete historical reports.
