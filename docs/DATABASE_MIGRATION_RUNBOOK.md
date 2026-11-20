# RELAY Production Database Migration Runbook

**Status:** Procedure only. No production/shared database was accessed or migrated. Do not treat passing isolated replica-set tests as production index verification.

## Pre-change gates

1. Approve the deployment window and identify the exact MongoDB database name. Have a verified backup and tested restore procedure.
2. Use a disposable, production-like database copy first. Run each phase's `--dry-run`, archive its duplicate/index report, and resolve every duplicate or conflicting index through a reviewed data repair. These scripts never delete historical records to resolve duplicates.
3. Use a protected operator environment for `MONGODB_URI` and confirmation variables. Do not put real credentials in shell history, logs, or tracked files.
4. Every script validates the URI protocol, exactly one non-reserved database name from the URI path, consistency of any `dbName` override, exact match to its expected database variable, and exact phase token before calling MongoDB `connect`. The validated URI is the URI used to connect. Dry-run still requires its phase's target confirmation. Phase 3 apply also needs a second structural-change token.
5. Stop application writes during phases that backfill/drop indexes (especially Phase 3) and monitor migration output.

## Ordered migration commands

Run from `server/`; set the named variables in a secure shell/CI secret context for the approved target. `<database-name>` below is a placeholder. For every phase, `MONGODB_URI` path database, expected database variable, and confirmation token suffix must be exactly the same database name. Any URI `dbName` option must match the URI path.

```sh
# Phase 1: unique handover project/version
node scripts/migrations/phase1-handover-version-index.js --dry-run
node scripts/migrations/phase1-handover-version-index.js

# Phase 2: unique active assignment scope
node scripts/migrations/phase2-active-assignment-index.js --dry-run
node scripts/migrations/phase2-active-assignment-index.js

# Phase 3: repository status backfill, partial active-link index, old index drop
node scripts/migrations/phase3-repository-soft-unlink-index.js --dry-run
node scripts/migrations/phase3-repository-soft-unlink-index.js

# Phase 4: GitHub source/revision identity and active sync lock indexes
node scripts/migrations/phase4-github-sync-indexes.js --dry-run
node scripts/migrations/phase4-github-sync-indexes.js

# Phase 5: all declared model indexes not already satisfied, including required unique/TTL indexes
node scripts/migrations/phase5-production-model-indexes.js --dry-run
node scripts/migrations/phase5-production-model-indexes.js

# Read-only final verification of every index in the Phase 5 model manifest
node scripts/migrations/phase5-production-model-indexes.js --verify-only
```

Do not run a write command until that phase's dry-run report is reviewed and production change approval is recorded. Phase 3 writes additionally require `PHASE3_MIGRATION_CONFIRM_CHANGES`. Phase 5 stops on duplicate unique keys, incompatible index definitions, or missing target confirmation; it never drops existing indexes. `--verify-only` is read-only and exits nonzero if duplicates, conflicting indexes, or required indexes are found.

## Exact confirmation environment names and token formats

The strings below are taken from the migration scripts. Replace `<database-name>` with the exact target database name. These are confirmations, not credentials.

| Phase/script | Expected database variable | Confirmation variable and exact value |
| --- | --- | --- |
| 1 `phase1-handover-version-index.js` | `PHASE1_MIGRATION_EXPECT_DATABASE` | `PHASE1_MIGRATION_CONFIRM_TARGET=APPLY_PHASE1_HANDOVER_VERSION_INDEX:<database-name>` |
| 2 `phase2-active-assignment-index.js` | `PHASE2_MIGRATION_EXPECT_DATABASE` | `PHASE2_MIGRATION_CONFIRM_TARGET=APPLY_PHASE2_ACTIVE_ASSIGNMENT_INDEX:<database-name>` |
| 3 `phase3-repository-soft-unlink-index.js` | `PHASE3_MIGRATION_EXPECT_DATABASE` | `PHASE3_MIGRATION_CONFIRM_TARGET=APPLY_PHASE3_REPOSITORY_SOFT_UNLINK_INDEX:<database-name>` and apply-only `PHASE3_MIGRATION_CONFIRM_CHANGES=APPLY_PHASE3_REPOSITORY_SOFT_UNLINK_CHANGES:<database-name>` |
| 4 `phase4-github-sync-indexes.js` | `PHASE4_MIGRATION_EXPECT_DATABASE` | `PHASE4_MIGRATION_CONFIRM_TARGET=APPLY_PHASE4_GITHUB_SYNC_INDEXES:<database-name>` |
| 5 `phase5-production-model-indexes.js` | `PHASE5_MIGRATION_EXPECT_DATABASE` | `PHASE5_MIGRATION_CONFIRM_TARGET=APPLY_PHASE5_PRODUCTION_MODEL_INDEXES:<database-name>` |

All phases also require `MONGODB_URI`. Do not include or print its value in reports.

## Indexes covered

Phases 1–4 preserve their existing phase-specific data migrations and unique indexes. Phase 5 is the complete current Mongoose schema index manifest (including phase 1–4 indexes for verification), covering users, findings, analysis jobs, audit events, contradiction candidates, GitHub install states/installations/sync jobs, deletion jobs, handovers/signoffs, project assignments/repositories, review histories, sources, and source revisions.

Important constraints explicitly preflighted before unique index creation include:

- `{ project, version }` on handovers.
- Active assignment scope; active project/repository link.
- GitHub source identity and `{ source, revisionKey }` source-revision identity.
- One active GitHub sync per repository link.
- Unique GitHub install-state `stateHash` and GitHub `installationId`.
- Unique `{ project, candidateKey }` contradiction candidate.
- Unique project deletion-job `projectId`.
- Unique handover/signer signoff constraint.
- Unique user email and sparse finding analysis key.

The Phase 5 manifest also creates the TTL indexes on `GitHubInstallState.expiresAt`, `AuditEvent.expiresAt`, and `HandoverSignoff.expiresAt` (`expireAfterSeconds: 0`). TTL deletion is asynchronous MongoDB cleanup, not an exact-time erasure guarantee. Non-unique query indexes declared by models are included too.

Phase 3 is the only listed migration with a planned index drop and data backfill. Its duplicate preflight runs before collection creation, index creation, status updates, or index dropping. Phase 5 reports conflicting indexes and stops; it does not automatically replace or drop them.

## Verification and rollout

1. Preserve dry-run and apply output (database name, duplicate summaries, index plans); do not preserve connection URIs or secrets in logs.
2. Run the Phase 5 `--verify-only` command with its expected database and exact confirmation token. Require `verified: true`, no duplicate summaries, and no missing/conflicting index plan.
3. Independently inspect `listIndexes` for each collection and compare against `server/scripts/migrations/phase5-production-model-indexes.js`; verify TTL values are zero and partial filters/unique/sparse options match.
4. Run post-migration smoke checks for handover allocation, active assignment uniqueness, GitHub source/revision idempotency, sync locking, contradiction de-duplication, deletion-job creation, signoff creation, and TTL metadata.
5. Keep normal traffic paused through structural changes and required verification. Resume only after application and database owners approve the evidence.

MongoDB `autoIndex` is disabled by the production connection helper. `Model.init()` is therefore not a production index-creation guarantee. Production must follow this explicit runbook and complete both scripted and independent index verification. The migrations have been validated in code/tests against an isolated local replica set only; production target compatibility and indexes remain unverified until an approved migration is executed and verified.
