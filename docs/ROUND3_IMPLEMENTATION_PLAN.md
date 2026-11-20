# RELAY Round 3 Implementation Plan

**Status:** Phases 1–7 implemented, including GitHub ingestion, revision-pinned analysis, contradiction review, version-specific signoff, deletion/recovery, and frontend workflows. Production runtime and migration verification remain deployment gates.
**Architecture authority:** [ROUND3_ARCHITECTURE_DECISIONS.md](ROUND3_ARCHITECTURE_DECISIONS.md)
**Roadmap:** [ROUND3_ROADMAP.md](ROUND3_ROADMAP.md)

This document records the approved implementation sequence and acceptance criteria. All listed phases are implemented in the current working tree; use current routes/models/services as implementation authority and retain production migration/runtime checks as release gates.

## Approved constraints to preserve

- GitHub App only; read-only Contents and Issues; private key remains server-side; installation tokens are short-lived and are not persisted.
- A server-authorized project owner links an installation. A verified installation may serve multiple RELAY projects. No public repository import outside the GitHub App connection.
- Phase 4 manual sync only: at most 50 recent commits and latest 100 updated issues across all states excluding pull requests; README when available; no issue comments. Limits: 2 MiB raw response, 8 MiB aggregate normalized content per sync, plus approved item/category caps detailed in [ROUND3_PHASE4_IMPLEMENTATION_PLAN.md](ROUND3_PHASE4_IMPLEMENTATION_PLAN.md). Scan at most five pages of 100 raw issue entries and report actual qualifying count; mark partial if the cap prevents reaching 100. No worker, webhook, or scheduled sync.
- Historical source revisions referenced by findings, contradiction candidates, or handovers remain available after unlink.
- Contradictions remain candidates until human confirmation. Only confirmed conflicts appear in a separate handover section with evidence and reviewer rationale.
- Keep `owner`, `editor`, and `viewer`; use separate reviewer, approver, and audit-reader assignments. Assignment grants no editor permissions.
- Existing projects preserve legacy review behavior until owner opt-in. New projects use assigned workflow. A handover creator cannot approve their own version.
- One approval is sufficient; any rejection is terminal for that version and requires a reason. Sign-offs are append-only and version-bound.
- Older pending versions become ineligible through computed superseded status; stored historical status is not rewritten.
- Project deletion uses a 30-day recovery window followed by scheduled retryable cleanup. Post-purge audit/sign-off metadata retention is configurable.
- Audit reads are limited to project owners and explicitly assigned audit readers. Audit events cover assignments, reviews, sign-offs, GitHub syncs, and deletion.
- Preserve the current local Vite proxy configuration to port 5001 during implementation.

## Phase 0 — Baseline and migration preflight

**Scope:** Capture the baseline already verified in the roadmap: backend tests, backend syntax check, and frontend production build. Inspect production-like database data before changing indexes. Identify duplicate `(project, version)` handovers, malformed legacy project membership records, and existing source/evidence shapes. Prepare migration inventory and recovery/backup procedure.

**Dependencies:** None.

**Acceptance criteria:** Baseline remains reproducible; migration inventory is reviewed; duplicate handover versions are reported with project/version/record IDs and a documented resolution proposal; no production index or data is changed during preflight; Vite proxy remains on port 5001.

**Tests:** Run the existing backend suite, `npm run check`, and client build. Record exact results. Add no new application tests in this phase unless the baseline has changed since setup.

**Migration/backward-compatibility risks:** Existing duplicate versions will prevent a unique compound index. Do not silently delete or merge saved reports. Resolve duplicates through an owner-approved archival/renumbering plan with a backup and audit record before index enforcement. Inventory old projects before assigning workflow defaults.

## Phase 1 — Reliability, schema foundations, and safe migrations

**Scope:** Make handover version allocation atomic and enforce unique `{ project, version }`. Validate AI output types consistently for both providers. Add additive foundations for `AuditEvent`, `ProjectAssignment`, `SourceRevision`, contradiction candidates, sign-offs, and deletion jobs only as needed by later phases. Add configurable `expiresAt` retention and TTL indexes for post-purge audit/sign-off metadata. Add safe defaults for old records (`reviewMode: legacy_editors`, upload provider). Do not add user-facing workflows yet.

**Dependencies:** Phase 0 inventory and duplicate-version resolution plan.

**Acceptance criteria:**

- Concurrent handover creation cannot produce duplicate versions; the database unique index is the final guard.
- Existing saved handovers remain readable and render the same PDF content.
- Invalid AI fields become a typed validation failure and do not persist partial findings.
- Old projects resolve to legacy editor behavior; old sources resolve to upload provider; old evidence without revision IDs remains readable.
- Audit records use minimized safe fields and do not include source/report contents or secrets.
- Migrations are idempotent and have a documented backup/rollback path before destructive operations.

**Tests:** Unit tests for strict provider schema validation and version allocation. Transaction-capable MongoDB integration tests for concurrent generation and unique-index behavior. Migration tests for old projects, sources, findings/evidence, and handovers. Verify rollback when index creation finds unresolved duplicates.

**Migration/backward-compatibility risks:** Mongoose defaults do not necessarily update existing documents; explicitly backfill or safely treat absent values as legacy. Unique index creation must follow duplicate resolution. Existing provider output acceptance may change; retain clear sanitized errors and regression fixtures.

## Phase 2 — Assignment model and backend permission enforcement

**Scope:** Add reviewer, approver, and audit-reader assignments separately from member roles. Add `workflowPolicy.reviewMode` and `signoffMode`. New projects start assigned; existing projects remain legacy until owner opt-in. Implement server-side assignment checks and append-only assignment/review audit events. Preserve existing editor review routes under legacy mode.

**Dependencies:** Phase 1 schema/audit foundations. Sign-off routes are not part of this phase.

**Acceptance criteria:**

- Existing owner/editor/viewer membership values and project editing behavior are unchanged.
- Reviewer assignments permit only scoped review actions; approver assignments permit only scoped sign-off actions; audit-reader assignments permit audit reads only.
- None of these assignments grants editor, upload, project-edit, or membership-management rights.
- Existing projects continue legacy editor review until an owner explicitly opts in; new projects default to assigned workflow.
- Reassignment/revocation preserves prior assignment history. Member removal revokes assignments atomically.
- Only owners and assigned audit readers can read audit events.

**Tests:** Unit tests for scope/policy helpers and assignment transitions. Integration tests for owner/editor/viewer/reviewer/approver/audit-reader/non-member route matrix, cross-project IDOR, immediate revocation, category scope, member removal, legacy-mode compatibility, and audit read denial.

**Migration/backward-compatibility risks:** Do not change `Project.members.role` enum. Backfill existing projects to `legacy_editors` or preserve absent mode as legacy. Assignment documents must reference existing project members; avoid population requirements for old records. Existing clients may not display assignments but must continue functioning.

## Phase 3 — GitHub App setup, installation authorization, and repository linking

**Scope:** Add server-only GitHub App authentication, one-time callback state, installation verification, repository listing, project linking/unlinking, and audit events. Do not implement ingestion in this phase. Use native `fetch` unless implementation evidence justifies an SDK.

**Dependencies:** Phase 1 audit and migration foundation; Phase 2 owner authorization. GitHub App registration, callback URL, and deployment secret configuration must be prepared separately.

**Acceptance criteria:**

- Callback state is single-use, expires, and binds the initiated RELAY user/project.
- Backend verifies the project owner is authorized to use the installation and that the selected repository is available to it.
- Installation reuse across projects works without exposing installation tokens.
- No public repository can be linked outside this authorization path.
- Only the required read-only Contents and Issues permissions are requested/documented.
- Link/unlink actions are audited. Unlinking one project does not uninstall an installation shared by other projects.

**Tests:** Mocked provider tests for valid/invalid/expired/replayed callback state, installation suspension/removal, repository inaccessible, repo rename/transfer, denied public unauthenticated import, and secret redaction. Route tests for owner/editor/viewer access and cross-project installation IDs.

**Migration/backward-compatibility risks:** No changes to existing uploads. Keep GitHub connection configuration optional so missing GitHub settings do not prevent server startup or current workflows. Callback behavior must not depend on a browser-held GitHub token. Before deploying repository soft unlink to a database with existing `ProjectRepository` records, backfill missing status values as active, create the partial active-link unique index, then remove the older global unique index; see `ROUND3_PHASE3_MIGRATION.md`. Do not physically remove unlinked repository records because later source revisions will reference their stable IDs.

## Phase 4 — Bounded manual GitHub ingestion and immutable revisions

**Approved scope:** Current project owners manually start synchronous, bounded GitHub sync. Import the README, at most 50 recent commits, and the latest 100 updated issues across all states, excluding pull requests. Do not ingest issue comments, commit diffs, webhooks, background jobs, or scheduled sync. Approved limits: raw response 2 MiB per response before JSON parsing; aggregate normalized content 8 MiB per sync; README 256 KiB; commit message 8 KiB each/256 KiB aggregate; issue title/body 16 KiB each/1 MiB aggregate. Scan at most five pages of 100 raw issue entries and report actual issue count, marking partial if the cap prevents reaching 100.

Add persisted `GitHubSyncJob` state with atomic per-link active locking, lease/deadline handling, category/page checkpoints, safe progress counts, retry timing, and explicit owner retry. A client disconnect must not cancel the server-owned job. Timeout or process termination must result in an expired/reclaimable lease, never a permanent running lock. Retries resume from checkpoints and rely on unique source/revision identities for idempotency.

Use existing `Source` and `SourceRevision` schemas and indexes where possible. Revisions are immutable; retain historical link provenance through `SourceRevision → Source → ProjectRepository`. Refresh installation status when stale and verify repository access during sync. Recheck project ownership and active link status during each persistence transaction. Never ingest from an unlinked link.

Integrate GitHub sources with existing per-source AI jobs by pinning the exact revision in each new analysis job and attaching that revision to finding evidence. Preserve old findings unchanged; do not mark them stale. Existing uploads and legacy jobs remain readable. Reject direct deletion of GitHub sources; preserve their source and revision records. Never physically delete history referenced by findings or handovers.

**Dependencies:** Phase 3 verified links/soft-unlink; Phase 1 `SourceRevision`; deployed Vercel runtime verification; Phase 4D verified revision pinning before AI is enabled for GitHub sources.

**Acceptance criteria:**

- Sync/retry are owner-only; project members can read only their own project’s sync status.
- Commit and issue limits, page/object scans, per-item/aggregate content, and raw response bytes are enforced in code, not only documented.
- One active job per repository link is enforced atomically across instances. Expired jobs can be reclaimed by explicit owner retry.
- A partial retry resumes at persisted checkpoints without duplicate Source, SourceRevision, or finding records.
- Browser disconnect does not abort or corrupt persisted work; strict server-side deadline and lease expiry prevent stuck jobs.
- Ownership transfer or unlink during provider calls prevents the fetched-but-not-yet-persisted batch from being committed.
- Old revisions and findings remain intact after source updates or unlink; upload workflows remain unchanged.
- No credentials/tokens/raw provider payloads appear in responses, logs, jobs, or audit metadata.

**Tests:** Unit/provider tests for pagination, caps, issue ordering and PR exclusion, huge/malformed payloads, Unicode truncation, revision keys, rate limits and deadlines. Replica-set integration tests for active-lock races, transaction rollback, owner-transfer/unlink races, disconnect recovery, partial retry, duplicate sync, immutable revisions, and audit atomicity. Analysis tests prove exact revision pinning, revision-aware deduplication, new-revision eligibility, and legacy upload/job compatibility. Run full backend tests against the isolated test replica set, backend checks, JavaScript syntax checks, frontend build, and `git diff --check`.

**Migration/backward-compatibility risks:** Preflight duplicate GitHub Source identities and `{ source, revisionKey }` records before unique-index creation. Phase 4A provides an idempotent index migration and tests it only against the isolated local test replica set; do not run it against production/shared data during implementation. See [Phase 4A migration notes](ROUND3_PHASE4A_MIGRATION.md). New revision/evidence/job fields remain optional for legacy data. Existing upload `analysisCompletedAt` behavior remains unchanged; GitHub sources use a revision watermark. See [the detailed Phase 4 plan](ROUND3_PHASE4_IMPLEMENTATION_PLAN.md) for the staged sequence, bounds, timeout/recovery design, test matrix, and unresolved limits.

## Phase 5 — Combined context and provenance-preserving analysis

**Scope:** Build bounded combined context from selected upload and GitHub source revisions. Phase 4 first adds revision pinning to the existing per-source analysis workflow; Phase 5 adds deterministic multi-source context. Preserve exact evidence-to-revision mapping in new findings. Keep existing one-source uploaded-document analysis working during migration; do not silently mix every project source into an unbounded prompt.

**Dependencies:** Phase 4 immutable revisions; existing analysis job persistence and evidence verification.

**Acceptance criteria:**

- An analysis request selects a deterministic set of source revisions under configured size limits.
- Each returned evidence item maps to a specific source revision and supported locator, or is rejected/marked unverified according to the approved evidence policy.
- Provider output is schema-validated, quotes are checked against the referenced revision text, and provider errors remain sanitized.
- Retrying a job cannot duplicate findings for the same source/revision/content.
- Existing findings and analysis jobs remain readable and resumable.

**Tests:** Unit tests for deterministic context selection, aggregate truncation, revision IDs in prompts/output, quote verification against the correct revision, and duplicate keys. Integration tests for mixed uploads/GitHub context, stale revision race, provider failure/retry, and legacy source analysis.

**Migration/backward-compatibility risks:** Findings currently associate evidence with `Source` but not necessarily a revision. New fields must be optional. Do not backfill unverifiable revision links by guessing; preserve legacy evidence state.

## Phase 6 — Contradiction candidates and human review

**Scope:** Generate candidate conflicts/supersession signals from distinct source revisions, validate the evidence, implement human review lifecycle, and audit every transition. Add confirmed conflicts to a separate handover section only after approval.

**Dependencies:** Phase 2 reviewer authorization and Phase 5 revision-aware analysis.

**Acceptance criteria:**

- Every candidate contains at least two distinct revision references and verifiable evidence.
- AI labels remain cautious; AI cannot set `confirmed_conflict`.
- Only assigned reviewers in assigned mode (or legacy-authorized editors in legacy mode) can confirm, mark stale, resolve, or dismiss.
- Candidate evidence and prior decisions remain unchanged when newer revisions arrive.
- Only human-confirmed conflicts appear in a separate handover section, including evidence and reviewer rationale; all other candidate states are excluded.

**Tests:** Unit tests for status transitions, candidate deduplication, temporal ambiguity, stale-versus-conflict behavior, and quote validation. Integration/security tests for unauthorized review, concurrent detection, duplicate candidate insertion, immutable history, and handover inclusion/exclusion rules.

**Migration/backward-compatibility risks:** Existing finding review history is not contradiction history. Keep the candidate lifecycle separate or use a clearly typed audit target; do not reinterpret legacy findings as contradiction candidates. Existing report snapshots remain unchanged.

## Phase 7 — Version-linked handover sign-off

**Scope:** Add approval/rejection endpoints and immutable `HandoverSignoff` records. Enforce assigned approver access, creator exclusion, one approval sufficient, rejection terminal with reason, and computed superseded status for outdated pending versions.

**Dependencies:** Phase 1 unique version allocation, Phase 2 assignments/audit authorization, Phase 6 confirmed-conflict report inclusion if that feature ships in the same report format.

**Acceptance criteria:**

- Sign-off records identify project, handover ID/version, signer, decision, timestamp, and a required comment; rejection also requires a reason.
- Only an active assigned approver who is not the handover creator can sign.
- One approval sets that version approved; any rejection sets that version rejected and requires a reason.
- A new version starts without inherited sign-offs. Old approved versions remain historically approved; old pending versions are computed as superseded and cannot sign off.
- Report content is immutable after generation. Sign-off and audit writes are transactional and append-only.

**Tests:** Unit tests for rules, required comments/rejection reasons, and computed status. Integration tests for duplicate sign-offs, creator rejection, unassigned approver denial, cross-project IDs, terminal rejection, stale version rejection, new-version reset, historical read access, and transaction rollback.

**Migration/backward-compatibility risks:** Preserve old `approvalStatus: draft` handovers and PDFs. Add new states without rewriting old snapshots. Do not mark old reports approved based on finding approvals; those are distinct decisions.

## Phase 8 — Project deletion tombstone and scheduled cleanup

**Scope:** Add owner deletion request, immediate access freeze, 30-day recovery/cancellation, scheduled cleanup with bounded retryable jobs, storage deletion, content purge, and retained minimal audit/sign-off metadata under configurable retention policy.

**Dependencies:** All source, contradiction, assignment, handover, sign-off, audit, and GitHub models that deletion must process. Deployment scheduling/authentication must be configured before production use.

**Acceptance criteria:**

- Tombstone immediately blocks normal project access and prevents in-flight analysis/sync from persisting new results.
- Owner can cancel deletion during the 30-day recovery window before purge begins.
- The API exposes an owner-authorized cancellation operation during the recovery window; once purge starts, cancellation is rejected.
- After the window, scheduled processing retries object-store and database cleanup idempotently; no open browser is required.
- Shared GitHub installations remain intact when one project is deleted.
- Completion is reported only after required cleanup succeeds.
- After content purge, only the approved audit/sign-off fields remain, and configured retention expiration is enforced.

**Tests:** Unit tests for deletion state machine, cancellation, bounded batch cursor, retry classification, and retention expiry. Integration tests for access freeze, cancel-before-purge, local/Supabase partial failure, repeated processing, shared installation, in-flight job race, records across all feature collections, retained metadata allowlist, and scheduled endpoint authentication.

**Migration/backward-compatibility risks:** The existing delete route hard-deletes the Project only and has no cascade. Replace behavior carefully with `202` plus job status; update the client to handle asynchronous deletion. Existing orphan records need an inventory and explicit policy; do not infer project ownership from dangling records. Object removal cannot be included in MongoDB transactions.

## Phase 9 — UI, documentation, and demo readiness

**Scope:** Implement the user-facing surfaces only after API states and authorization contracts stabilize: GitHub connection/link/sync, source provenance, contradiction review, assignments, sign-off history, deletion status/cancel, accessible empty/loading/error/retry states, and a concise demo walkthrough. Update README, architecture, API, setup, deployment, limitations, and demo docs.

**Dependencies:** Backend phases 2–8, finalized API schemas, and test fixtures.

**Acceptance criteria:**

- UI distinguishes source captures, AI candidate labels, verified evidence, human review, and signed handover versions.
- Owner/editor/viewer/reviewer/approver/audit-reader controls match backend authorization.
- Sync, sign-off, and deletion show progress, failures, and retry/cancel affordances accurately.
- Keyboard and screen-reader flow is usable for dialogs, assignment forms, contradiction decisions, and sign-off.
- Demo completes with a disposable repository/project and does not imply live data when using fixtures.
- Documentation matches actual environment-variable names, provider permissions, limits, retention, and endpoint behavior.

**Tests:** Browser end-to-end happy path plus representative unauthorized attempts; keyboard/accessibility pass; responsive viewport smoke pass; docs/API spot-check against routes; production build. Test with mocked GitHub and AI by default, then a separately controlled provider smoke test if credentials are available.

**Migration/backward-compatibility risks:** Existing client views assume current project/source/finding/handover shapes. Keep new response fields additive and retain old defaults until clients have migrated. Preserve `client/vite.config.js` proxy target `http://127.0.0.1:5001` throughout.

## Cross-phase database migration and release strategy

1. **Preflight and backup:** Inventory affected records and duplicate indexes. Take a verified backup before production migrations.
2. **Expand:** Add optional fields and new collections/indexes that do not invalidate existing documents. Keep absent `reviewMode` equivalent to `legacy_editors` and absent `Source.provider` equivalent to `upload`.
3. **Backfill:** Use idempotent, resumable scripts. Record counts and errors; never guess evidence revision links.
4. **Resolve conflicts before constraints:** Resolve duplicate `{ project, version }` records with owner-approved policy before creating the unique index. Stop migration on unresolved ambiguity.
5. **Enforce:** Add unique/partial indexes after backfill and preflight checks; verify index definitions after rollout.
6. **Contract only after adoption:** Do not remove legacy fields or routes in Round 3 unless a separate migration plan proves no old client/data depends on them.
7. **Destructive purge:** Run only through the scheduled deletion processor after the 30-day recovery deadline and under the approved configurable retention policy.

## Global release gates

- Backend tests, backend check, and frontend build pass after every phase that changes runtime code.
- Every new mutation has route-level authorization tests including cross-project IDs.
- GitHub/model/storage secrets, signed URLs, private content, and callback state do not enter logs or browser bundles.
- Concurrency-sensitive operations have database constraints or conditional writes, not only in-process locks.
- Failure and retry behavior is tested for GitHub sync, MongoDB persistence, storage cleanup, and scheduled job processing.
- Existing upload, finding/evidence, review, handover, and PDF flows pass backward-compatibility tests.
- Documentation and demo are updated only after implementation behavior is verified.

## Remaining operational configuration

Configure audit and sign-off retention durations, GitHub App/provider credentials and callback URLs, cron authentication, CORS, storage, and the deployed function runtime. The approved GitHub per-response, per-item, aggregate-content, pagination, and sync-deadline limits are hard-coded application safeguards, not deployment environment variables. Changing them requires a reviewed code change and corresponding tests; do not tune them through deployment configuration.
