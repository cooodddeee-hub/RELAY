# RELAY Round 3 Architecture Decisions

**Status: Architecture approved and implemented through Round 3 delivery; production rollout gates remain**
**Approved:** Product owner, 2026-11-16; Phase 4 clarifications approved 2026-11-17
**Scope:** Approved architecture decisions and implementation reference for GitHub ingestion, contradiction intelligence, reviewer/approver workflow, handover signoff, deletion/recovery, and audit retention.

**Implementation status:** These features are implemented in the current source tree. This document records the approved design; it does not certify production migrations, environment values, cron registration, or browser-level verification.

The implementation uses the existing Express/Mongoose API and [Round 3 roadmap](ROUND3_ROADMAP.md). Project membership retains `owner`, `editor`, and `viewer`; GitHub sources and immutable revisions coexist with uploads; findings retain revision evidence; handovers are immutable versioned snapshots with optional assigned signoff; contradiction candidates require human confirmation; deletion uses a tombstone and retryable cleanup.

## Decision 1 — GitHub integration

### Decision

- Use a **GitHub App** for private repositories and organization installations.
- Request read-only **Contents** and **Issues** permissions. Do not request write permissions for the initial integration.
- Mint short-lived installation access tokens when the backend calls GitHub. Do not persist installation tokens in MongoDB or expose them to the browser.
- Keep the GitHub App private key in server-side environment configuration or an equivalent deployment secret store.
- Start with bounded, manually triggered repository sync. Import README, a bounded set of recent commits, and a bounded set of issues.
- Import the latest 100 updated issues across all states, excluding pull requests. Do not ingest issue comments in Phase 4.
- Approved limits are 2 MiB raw response bytes per response before JSON parsing; 8 MiB aggregate normalized content per sync; README 256 KiB; commit message 8 KiB each/256 KiB aggregate; issue title/body 16 KiB each/1 MiB aggregate.
- Scan at most five issue pages of 100 raw entries. If the repository is exhausted earlier, report the actual qualifying issue count as complete. If the scan cap prevents reaching 100, report the actual count and mark the issue result partial.
- Provider requests time out after 10 seconds. The synchronous sync job has a 45-second server-owned deadline, subject to the deployed Vercel runtime check described in the Phase 4 plan.
- Sync is synchronous and bounded, manually initiated by a current project owner, and persisted with checkpoints. Retries require an explicit owner request. Do not add a background worker, webhooks, or scheduled sync.
- A strict server-owned execution deadline and expiring lease are required. Client disconnect must not cancel or corrupt a persisted sync. An expired lease must be reclaimable without leaving a permanently running job.
- Active sync claims must be atomic across concurrent requests. Partial retry resumes from persisted category/page checkpoints, with unique source/revision keys preventing duplicate records.
- Refresh installation status when stale and verify installation access to the linked repository during each sync.
- Retain old findings against their original source revision; do not automatically label them stale in Phase 4.
- Never physically delete a GitHub source or revision referenced by findings or handovers. Use a safe archive/rejection policy for GitHub sources.
- Preserve provenance through the existing `SourceRevision → Source → ProjectRepository` relationship unless implementation demonstrates a need for a direct immutable link reference.
- Do not import public repositories outside a verified GitHub App connection.
- Do not add webhooks in the initial implementation. Manual sync reduces inbound request and deployment complexity; webhook support can follow if freshness requirements justify it.
- Preserve provenance and immutable source revisions. Analysis evidence must identify the exact captured source revision, not just a mutable URL or branch name.

### Rationale

Installation-scoped access remains the credential used for repository APIs. GitHub's setup callback alone does not identify the user who completed installation, so RELAY also performs a one-time GitHub user authorization and verifies that the initiating user can access the installation. The temporary user token is revoked before RELAY persists authorization; neither user nor installation tokens are persisted. Bounded on-demand sync fits RELAY's existing Vercel/serverless architecture and persisted job patterns; it also limits API usage and AI context size.

### Proposed data model and indexes

**`GitHubInstallation`**

```text
installationId       Number/String, required, unique
accountId             Number/String, required
accountLogin          String, required
accountType           enum: user | organization
installedBy           User ref, required
authorizedUsers      User refs, verified by GitHub user authorization
status                enum: active | suspended | removed
grantedPermissions    safe permission summary
lastVerifiedAt        Date
createdAt, updatedAt
```

Tokens are intentionally absent. Create them for an outbound request and retain them in memory only for that request.

**`ProjectRepository`**

```text
project               Project ref, required
installation          GitHubInstallation ref, required
repositoryId          Number/String, required
ownerLogin            String, required
name                  String, required
fullName              String, required
defaultBranch         String
linkedBy              User ref, required
status                enum: active | unlinked
unlinkedAt            Date
unlinkedBy            User ref
createdAt, updatedAt
```

Indexes: unique partial `{ project, repositoryId, status }` where `status: active`; `{ installation, repositoryId, status }`; `{ project, status, createdAt }`. Unlinking retains the link document and its stable ID. Relinking creates a new active link document so older source revisions continue to reference the historical link identity.

Track sync state in a separate `GitHubSyncJob`, not on the stable repository-link identity. The job stores project, link, installation, requesting owner, category/page checkpoints, safe counts and error codes, retry time, lease token/expiry, and lifecycle timestamps. Use an atomic active-job claim and a partial uniqueness guard per repository link. Do not store provider payloads or credentials in the job.

**`GitHubInstallState`** binds the provider callback to the initiating RELAY user and project:

```text
stateHash             String, required, unique
project               Project ref, required
actor                 User ref, required
purpose               enum: setup | oauth
installationId        String, present for OAuth verification state
expiresAt             Date, required
consumedAt             Date
```

Add a TTL index on `expiresAt`; store a hash of the one-time state rather than the raw state.

**Extend `Source`** with `provider` (`upload`/`github`), `externalType` (`repository`/`readme`/`commit`/`issue`), repository link, stable external ID/URL, external update timestamp, and current revision reference. Keep upload-specific fields optional and default existing records to `provider: upload`.

Index GitHub sources uniquely by `{ provider, repositoryLink, externalType, externalId }` with a partial filter. Add `{ project, provider, status }` for listing.

**New `SourceRevision`** fields: source ref, immutable `revisionKey`, content hash, bounded text snapshot, provider-updated time, captured time, and locator metadata. Index `{ source, revisionKey }` uniquely and `{ source, capturedAt: -1 }`.

Extend each finding evidence object with optional `sourceRevision` and `locator` fields. Existing evidence without a revision remains valid legacy evidence.

### API shape

- `POST /api/projects/:id/github/installations/start` — owner creates one-time setup state and receives the GitHub App installation URL.
- `GET /api/integrations/github/setup` — consumes setup state, verifies the installation with the App, creates a separate OAuth state, then redirects to GitHub user authorization.
- `GET /api/integrations/github/oauth/callback` — consumes OAuth state, verifies the user can access the installation, revokes the temporary user token, then records installation authorization.
- `GET /api/projects/:id/github/repositories?installationId=…` — owner lists repositories accessible to the installation.
- `POST /api/projects/:id/github/repositories` — owner links a revalidated repository and sync configuration.
- `GET /api/projects/:id/github/repositories` — project members view active linked-repository metadata; an `installationId` query requests repository discovery and is owner-only.
- `POST /api/projects/:id/github/repositories/:linkId/sync` — current project owner atomically claims and synchronously runs a bounded sync; return a persisted job/status ID.
- `GET /api/projects/:id/github/sync-jobs/:jobId` — project members read project-scoped sync progress.
- `POST /api/projects/:id/github/sync-jobs/:jobId/retry` — current project owner explicitly resumes a retryable or interrupted job from persisted checkpoints.
- `DELETE /api/projects/:id/github/repositories/:linkId` — owner unlinks a repository, subject to the approved retention behavior.
- `GET /api/projects/:id/sources/:sourceId/revisions` — project members inspect captured revision metadata.

### Permissions and security implications

Only project owners may authorize installations, discover repositories, create links, start/retry sync, or unlink. Project members (owner, editor, viewer) may read active linked-repository metadata and project-scoped sync status. Reviewer/approver assignments do not grant GitHub mutation permissions. The backend verifies that the initiating GitHub user can access the installation and that the installation can access the selected repository; client-submitted installation/repository IDs are not proof of authorization. Every sync claim and persistence batch rechecks the current project owner and active repository-link status transactionally. A verified installation may serve multiple RELAY projects. Project membership never grants GitHub repository access by itself; every fetch uses an installation that has access to that repository. Public repositories are not imported outside this same GitHub App authorization path.

Validate both callback states, expiry, one-time use, actor/project binding, installation ownership, and repository availability server-side. Keep project/repository writes and their append-only audit events in one transaction. Unlink by tombstoning the link; preserve its identity and audit metadata for historical provenance. Return active installation state as `unverified` when it has not been checked within five minutes; discovery/link operations refresh status, while sync refreshes stale status and verifies repository access. Enforce pagination, raw HTTP response bytes before JSON parsing, item limits, and aggregate content limits. Treat imported content as untrusted. Do not log private keys, installation tokens, callback state, signed URLs, provider response bodies, or full private content. The strict sync deadline is independent of client connection state; lease expiry and explicit owner retry recover interrupted work.

### Alternatives considered

- **Persistent OAuth/user tokens:** rejected because repository API access is installation-scoped and persistent user credentials add storage and lifecycle risk. The implementation uses a temporary user token only to verify installation access and revokes it before saving authorization.
- **Public repositories without a connection:** simpler but does not satisfy private repository authorization. Defer unless a public-only demo path is specifically requested.
- **Webhooks initially:** fresher but adds signature validation, event idempotency, endpoint availability, and deployment work. Defer until manual sync proves insufficient.
- **GitHub SDK:** not required for the initial REST calls; add only if it materially reduces API/versioning error risk.

### Dependencies and acceptance criteria

Depends on server-side GitHub App configuration, setup URL, OAuth callback URL, source/revision schema, and an idempotent sync-job pattern. See [GitHub App setup](GITHUB_APP_SETUP.md) for required configuration names and URL matching. Environment variable names and deployment setup must be documented without publishing values.

Accept when an authorized owner can link and manually sync only a repository accessible to the verified installation; each run captures no more than 50 recent commits and the latest 100 updated non-PR issues across all states, plus the README, within approved item, category, aggregate-content, raw-response, and scan limits. Checkpoints and leases make partial work retryable and nonduplicating. A client disconnect cannot cancel persisted work; a deadline or process interruption leaves a reclaimable job, not a permanent lock. Every capture has stable identity and immutable revision provenance. Existing analysis jobs pin the selected revision for GitHub sources; old findings remain unchanged and revision-linked. Sync does not automatically start analysis. Upload workflows and legacy jobs remain readable. No issue comments, webhooks, worker, or scheduled sync are introduced.

## Decision 2 — Contradiction intelligence

### Decision

- Add **contradiction candidates** supported by evidence from distinct source revisions.
- AI may propose candidates and explain the possible relationship; AI cannot declare a conflict confirmed.
- Use cautious labels and confidence bands (`low`, `medium`, `high`) rather than presenting model confidence as a calibrated probability.
- Require human review for confirmation, dismissal, resolution, or stale-information classification.
- Preserve historical candidate records and evidence snapshots. New source revisions must not rewrite prior candidates or their review decisions.

### Rationale

The existing finding workflow already separates AI proposals from human review. Contradiction detection should preserve that boundary. Requiring revision-specific evidence makes a conflict reproducible and helps distinguish two disagreeing claims from a claim that may simply have been superseded.

### Proposed `ContradictionCandidate` fields and indexes

```text
project               Project ref, required
candidateKey          String, required
claims                 [{ summary, effectiveAt? }]
evidence               [{ source, sourceRevision, quote, matchedText,
                          startOffset, endOffset, locator, sourceUpdatedAt }]
relationship          enum: possible_conflict | possible_supersession
cautiousLabel          enum: needs_human_check | possible_conflict | likely_stale
confidenceBand         enum: low | medium | high
confidence             Number 0..1, optional
explanation            String, bounded
modelProvider          String
modelName              String
promptVersion          String
status                 enum: candidate | in_review | confirmed_conflict |
                       stale_information | resolved | dismissed
reviewedBy             User ref
reviewedAt             Date
reviewReason            String, bounded
createdAt, updatedAt
```

Require at least two distinct evidence/revision references for a conflict candidate. Index unique `{ project, candidateKey }`, `{ project, status, createdAt: -1 }`, and `{ 'evidence.sourceRevision': 1 }`.

Record lifecycle transitions in append-only `AuditEvent` or a dedicated contradiction history collection. The original evidence should remain addressable even when later source revisions arrive.

### Lifecycle, permissions, and security implications

```text
candidate → in_review → confirmed_conflict
                       → stale_information
                       → resolved
                       → dismissed
```

Project members may read candidates. In assigned mode, only an assigned reviewer may update candidate state; in legacy mode, retain existing editor review behavior. Require a reason for dismissal/resolution where useful. A terminal decision remains in history; subsequent evidence creates a new candidate linked to the earlier one.

Validate quotes and offsets against captured source revisions before storing candidates. Reject unsupported dates/quotes rather than trusting model output. Do not place unreviewed candidates in approved handovers as confirmed facts; show them as AI suggestions with explicit status.

Staleness is a human judgment based on evidence and temporal context. A later timestamp alone does not prove that a claim is current or correct. Only a human-confirmed conflict may appear in a handover, in a separate conflict section that includes supporting evidence and reviewer rationale. Candidates, stale information, dismissed items, and unresolved conflicts are excluded from that confirmed-conflicts section.

### Alternatives considered

- **Automatic conflict confirmation:** rejected because model output can be wrong and the current product model requires human review.
- **Confidence score alone:** rejected as misleading unless calibrated; use an explanatory band, optionally retaining the raw model score for internal diagnostics.
- **Overwrite old candidate when sources change:** rejected because it destroys the evidence basis for prior review decisions.

### Dependencies and acceptance criteria

Depends on immutable `SourceRevision` records and evidence mapping from the combined-context analysis pipeline. Accept when every candidate cites at least two distinct revisions, labels are explicitly tentative, reviewers can decide through authorized transitions, history preserves the original evidence and all decisions, and only confirmed conflicts are represented in a separate handover section with evidence and reviewer rationale.

## Decision 3 — Reviewer and approver permissions

### Decision

- Keep project roles as `owner`, `editor`, and `viewer`.
- Add separate, granular reviewer and approver assignments. Assignments do not automatically grant editor permissions.
- Existing projects keep legacy workflow behavior until an owner opts into assigned mode.
- New projects use assigned workflow mode by default.
- Enforce assignment scope and membership at the backend for every protected mutation.

### Rationale

Project roles describe baseline access. Reviewer/approver assignments describe a specific workflow responsibility. Keeping them separate avoids changing the existing membership enum and prevents a review assignment from silently granting source upload, project editing, or member management.

### Proposed `ProjectAssignment` schema and indexes

```text
project               Project ref, required
user                  User ref, required
role                  enum: reviewer | approver | audit_reader
scopeType             enum: project | category | handover
scopeValue            String
assignedBy            User ref, required
assignedAt             Date, required
status                 enum: active | revoked
revokedBy              User ref
revokedAt              Date
revokeReason           String
createdAt, updatedAt
```

Index `{ project, user, role, scopeType, scopeValue, status }`; add a unique partial index preventing duplicate active assignments in the same scope. Add project policy fields `workflowPolicy.reviewMode` (`legacy_editors`/`assigned`) and `workflowPolicy.signoffMode` (`none`/`assigned`). An `audit_reader` assignment grants audit-history read access only; it does not grant editor, reviewer, or approver powers.

### Permissions and lifecycle

Existing projects migrate to `legacy_editors`, preserving owner/editor finding review. Owners may opt into assigned mode after ensuring reviewer assignments exist. New projects use assigned mode and require the owner to establish assignments.

In assigned mode:

- A reviewer may review findings or contradictions only within the assignment scope.
- An approver may sign off only within the assignment scope.
- An audit reader may read audit events for the assigned project/scope only.
- Neither assignment grants editor rights, source upload, project editing, or member management.
- Owners manage assignments but do not bypass the assignment requirement for review/sign-off.
- A viewer may hold a reviewer or approver assignment and receives only those specific workflow powers.

Assignment, reassignment, and revocation are owner-only and audited. Reassignment revokes the old record and creates a new record rather than overwriting history. Removing a project member revokes their active assignments transactionally. A role change to viewer does not automatically revoke assignments because these are separate capabilities.

### API shape and security implications

- `GET /api/projects/:id/assignments` — project members read assignments; owners see history.
- `POST /api/projects/:id/assignments` — owner assigns a current project member and scope.
- `POST /api/projects/:id/assignments/:assignmentId/revoke` — owner revokes with reason.
- `POST /api/projects/:id/assignments/:assignmentId/reassign` — owner replaces an assignment while preserving history.
- `PATCH /api/projects/:id/workflow-policy` — owner changes policy; reject invalid modes with missing assignments.

Every write rechecks current membership, active assignment, scope, and resource/project relationship. Do not rely on client-hidden controls or cached authorization state. Handle assignment revocation concurrent with a review/sign-off by checking assignment state within the transaction or conditional write.

### Alternatives considered

- **Add reviewer/approver to project member roles:** rejected because it conflates project access with workflow duties and risks breaking current permission checks.
- **Allow every editor to review forever:** preserves behavior but does not satisfy granular assignment requirements. Keep only for projects still in legacy mode.
- **Owner automatically bypasses assignments:** easier recovery, but weakens separation of duties. Keep administration authority distinct from reviewer/approver assignment unless product explicitly chooses otherwise.

### Dependencies and acceptance criteria

Depends on the role-action matrix, assignment model, audit events, and compatibility migration. Accept when all review/sign-off routes enforce assigned mode server-side, legacy projects continue to behave as before, and an assignment grants no unrelated editor capability.

## Decision 4 — Handover sign-off

### Decision

- Sign-off is tied to an exact immutable handover ID and version.
- Store approver identity, project, handover version, decision, timestamp, and required comments/reasons.
- Rejection requires a reason.
- Sign-offs never carry over to newer handover versions.
- One approval is sufficient per version.
- Any rejection is terminal for that version and requires a reason.
- Pending sign-offs on outdated versions cannot approve the latest version.
- Keep approval history append-only. A rejected version is not edited in place; generate a new version for changes.

### Rationale

The current handover route already saves a point-in-time snapshot. A separate sign-off record preserves the author and decision against that snapshot without confusing later versions or mutating the approved report content.

### Proposed schema and indexes

Extend `Handover` with `approvalStatus` values `draft`, `pending`, `approved`, and `rejected`, plus a `signoffPolicySnapshot` such as required approval count and independent-signer rule. Keep `reportContent` immutable. Add a **unique `{ project, version }` index** after detecting and resolving existing duplicates. Add `{ project, approvalStatus, version: -1 }` for history queries.

New `HandoverSignoff`:

```text
project                 Project ref, required
handover                Handover ref, required
version                 Number, required
signer                  User ref, required
assignment              ProjectAssignment ref, required
decision                enum: approved | rejected
reason                  String, required for rejection
comment                 String, required, bounded
expiresAt               Date, required by configured retention policy
createdAt                Date, required
```

Index unique `{ handover, signer }`; index `{ project, handover, version, createdAt }`; TTL index on `expiresAt` with `expireAfterSeconds: 0` so post-purge metadata follows the configured retention duration.

### Lifecycle, permissions, and security implications

```text
draft → pending → approved
                 → rejected
```

Only an active assigned approver may sign an assigned-mode handover. Validate project membership, assignment scope, exact handover/version, current eligibility, duplicate decisions, and creator identity server-side. The handover creator cannot approve their own version. The owner has no implicit approver bypass in assigned mode; the owner may sign only if separately assigned and is not the creator.

When a new version is generated, it gets a new policy snapshot and starts with no sign-offs. Older sign-offs remain attached to their original version. An older pending version becomes ineligible for new decisions once a newer version exists; expose computed superseded status without rewriting the historical stored status or report snapshot. An outdated pending version cannot approve the latest version. An older approved version remains approved for that historical version only.

Write the sign-off record, handover status update, and `AuditEvent` in a MongoDB transaction. This is an application-level sign-off, not a cryptographic or legally qualified digital signature.

### API shape and alternatives considered

- `POST /api/handovers/:handoverId/signoffs` — assigned approver submits approval/rejection.
- `GET /api/handovers/:handoverId/signoffs` — project members read sign-off history.
- Extend existing handover list responses additively with status and sign-off summaries.

Alternative: store signers directly in `Handover`. Rejected because a separate append-only collection better preserves a decision trail and supports future multiple approvers without changing the snapshot structure.

### Dependencies and acceptance criteria

Depends on unique version allocation, assignment authorization, audit events, and duplicate-version migration. Accept when each decision references exactly one immutable version, every decision has a required comment, rejection also has a reason, duplicate signer decisions are prevented, newer versions require fresh approval, and outdated pending versions cannot approve the latest version.

## Decision 5 — Reliability and project deletion

### Decision

- Prevent handover version races with atomic version allocation and a unique `{ project, version }` index.
- Inspect and resolve existing duplicate project/version pairs before adding the unique index.
- Replace project hard-delete-only behavior with an immediate tombstone, a 30-day recovery window, and retryable cleanup after that window.
- Use a scheduled, retryable background processor with bounded batches; do not depend on the browser remaining open.
- Preserve only the required audit and sign-off metadata after content purge, for a configurable retention duration.

### Rationale

The implementation uses a short-lived handover lock and a unique `{ project, version }` index; production index preflight/migration remains a release gate. Project deletion now uses a tombstone, a recovery window, and retryable batched cleanup across MongoDB and configured object storage.

### Proposed deletion fields and job

Add to `Project`: `deletionState` (`active`/`queued`/`purging`/`blocked`/`complete`), `deletionRequestedAt`, `deletedAt`, and `deletedBy`.

Add `ProjectDeletionJob` with `projectId`, requester, policy version, status, phase, cursor, attempt count, safe last error code, retry time, and timestamps. Index unique `{ projectId }` and `{ status, nextAttemptAt }`.

Deletion stages:

1. Tombstone and immediately deny ordinary project access.
2. During the 30-day recovery window, stop analysis and sync but preserve data needed to restore the project; allow the owner to cancel deletion.
3. If deletion is not cancelled, detach project repository links without uninstalling installations shared elsewhere, then delete local/Supabase originals. Retain retry metadata if object deletion fails.
4. Purge source revisions, source text, findings, review history, contradictions, assignments, handover report content, and evidence after the recovery window.
5. Retain only the metadata listed below for its configured retention duration; do not retain source/report content or credentials in audit records.
6. Mark cleanup complete only after required object and database cleanup succeeds.

**Metadata retained after content purge:**

- Deletion event: project ID, requester user ID, request/completion timestamps, policy version, and cleanup outcome.
- Assignment events: actor user ID, target user ID, role/scope, action, and timestamp.
- Review events: actor user ID, target finding ID, action/decision, timestamp, and required reason/comment. Do not retain finding text or evidence quotations.
- Sign-off: project ID, handover ID/version, signer user ID, decision, timestamp, and rejection reason. Do not retain report content or evidence.
- GitHub sync events: actor user ID, repository numeric ID, action/status, counts, and timestamps. Do not retain repository content, credentials, or tokens in audit records.

The post-purge retention duration for audit/sign-off metadata is configurable through server-side retention policy; no fixed duration is part of this approval and it must be set before production. The 30-day recovery window is fixed by this decision.

Use bounded batches and idempotent retries. A scheduled processor claims due jobs and resumes after function termination. Do not claim completion while object deletion is pending.

### API shape, permissions, edge cases

- `DELETE /api/projects/:id` — owner-only; tombstones and queues cleanup, returns `202`.
- `POST /api/projects/:id/deletion/cancel` — owner-only; cancels deletion during the 30-day recovery window if purge has not begun.
- `GET /api/projects/:id/deletion` — authorized owner/requester checks status through a dedicated tombstone path.
- Scheduled processor endpoint — server-authenticated; claims and processes bounded cleanup batches.

Normal project middleware rejects tombstoned projects. Validate local paths against the configured upload root before deletion. A missing local file can be treated as idempotently removed. Keep a shared GitHub installation if another project uses it. In-flight analysis/sync must recheck project state before persistence. Previously issued signed URLs may remain usable until expiry, so keep their lifetime limited.

### Alternatives considered

- **Immediate cascade in the HTTP request:** rejected because object storage and MongoDB cannot commit atomically and serverless requests may time out partway through.
- **Soft delete with no eventual purge:** rejected because it leaves uploaded content and private repository captures indefinitely.
- **Owner-driven continuation only:** rejected because cleanup must progress even if the owner leaves the application. Owners retain status visibility and may cancel during the recovery window.

### Dependencies and acceptance criteria

Depends on version uniqueness, configurable retention policy, scheduled processor configuration, and audit retention. Accept when tombstoning denies access immediately; cancellation is possible during the 30-day recovery window; scheduled cleanup is idempotent/retryable; shared GitHub installations are not revoked accidentally; only enumerated audit/sign-off metadata survives content purge for the configured duration; and completion accurately reflects storage and database cleanup.

## Decision 6 — Append-only audit events

### Decision

Add an `AuditEvent` collection for assignments, reviews, sign-offs, GitHub link/sync operations, and project deletion operations. Events are append-only through application services; do not add update/delete routes. Audit history is readable only by project owners and explicitly assigned `audit_reader` users. An audit-reader assignment grants read access only.

Proposed fields: `projectId` (plain ObjectId to survive project purge), `actorId`, `action`, `targetType`, `targetId`, safe `previousValues`/`updatedValues`, reason/comment where applicable, `requestId`, `createdAt`, and configurable `expiresAt`. Index `{ projectId, createdAt: -1 }` and `{ targetType, targetId, createdAt: 1 }`; add TTL index on `expiresAt` with `expireAfterSeconds: 0`. Apply configured retention without retaining source text, report content, credentials, tokens, or signed URLs.

Keep `ReviewHistory` as the existing finding-review history API/model initially; append a matching audit event in the same transaction for new review actions. Avoid duplicating sensitive evidence or source content in audit records. Never record tokens, private keys, signed URLs, or full document bodies.

### Alternatives considered

- **Replace `ReviewHistory` immediately:** rejected to avoid breaking current clients and tests. Revisit after additive migration.
- **Audit only sign-off and assignments:** rejected because GitHub and deletion actions also affect project provenance and access.

### Dependencies and acceptance criteria

Depends on transaction patterns, audit-reader authorization, and configurable retention policy. Accept when each listed mutation produces exactly one attributable event atomically with the state change; only owners and assigned audit readers can read it; events cannot be altered through public APIs; and event content passes secret/data minimization checks.

## Decision 7 — Backward compatibility

### Decision

- Keep existing `owner`, `editor`, and `viewer` project roles.
- Keep existing uploaded sources supported; old source records default to upload provider semantics.
- Keep existing finding evidence readable even when it has no `SourceRevision`.
- Preserve legacy review behavior for existing projects until an owner explicitly opts into assigned workflow.
- Extend existing APIs additively where practical. Do not silently change current response shapes or permission behavior.
- Keep existing handover snapshots readable/downloadable; new sign-off fields are additive.

### Rationale and security implications

Additive schema/API changes reduce migration and demo risk. Authorization must not be weakened to preserve compatibility: old projects retain their existing editor review policy, while assigned-mode enforcement applies only after an explicit policy transition. Migration scripts must be idempotent, auditable, and safe to rerun.

### Dependencies and acceptance criteria

Depends on default values and migration policy for workflow mode, provider kind, version uniqueness, and any backfilled audit metadata. Accept when the existing application can still read/upload legacy sources, render old findings/evidence and handovers, and perform legacy review actions on projects not opted into assignment mode.

## Decision 8 — Testing strategy

### Decision

Add tests in layers while preserving the current Node test runner and service boundaries. Do not require live GitHub, AI, MongoDB, or Supabase credentials for ordinary unit tests.

### Test layers

- **Unit:** schema/normalization helpers, provider payload validation, revision IDs, candidate deduplication, lifecycle transitions, assignment scopes, sign-off rules, deletion phases, and audit-safe field selection.
- **Integration:** Express route tests against an isolated transaction-capable MongoDB test deployment or controlled test database; mock GitHub and storage HTTP calls. Verify persistence and rollback across related records.
- **Authorization:** table-driven owner/editor/viewer/reviewer/approver/non-member matrix; test cross-project IDs for every new read and mutation route; verify immediate revocation.
- **Concurrency:** concurrent handover generation, duplicate sync delivery, concurrent candidate creation, assignment revocation during review, duplicate sign-off, and deletion retry races.
- **Migration:** existing project defaults to legacy mode; uploaded sources remain upload sources; old evidence without revision remains readable; old handovers remain readable; duplicate handover versions are detected before unique-index creation.
- **Backward compatibility:** existing routes and client response usage continue; legacy editor reviews still work until opt-in; old PDFs render from saved snapshots.
- **End-to-end/demo:** disposable project walkthrough from GitHub link/sync through evidence-backed contradiction review, assigned sign-off, and audit display; include loading, empty, error, retry, and responsive states.

### Acceptance criteria

The backend test suite, backend check, and frontend build pass. New authorization/concurrency/migration tests cover the failure cases above. At least one browser walkthrough verifies the complete happy path and a denied unauthorized action. Logs and browser bundles contain no GitHub credentials or private key material.

## Recommended implementation dependencies

1. Resolve duplicate handover versions and establish atomic version allocation before sign-off work.
2. Approve retention and add the append-only audit foundation.
3. Add GitHub App installation and repository linking.
4. Add immutable source revisions and source-associated GitHub ingestion.
5. Add combined context/evidence revision mapping.
6. Add contradiction candidates and review lifecycle.
7. Add assignment policies and backend enforcement, preserving legacy mode.
8. Add version-linked sign-off.
9. Add tombstone-driven deletion processing, then finish UI, tests, documentation, and demo.

## Approved product-owner decisions

The product owner approved all ten architecture decisions on 2026-11-16, with the following clarifications recorded as binding implementation requirements:

1. **GitHub installation reuse:** An installation may serve multiple RELAY projects. Project owners may link installations only after server-side authorization verifies their right to use the installation and its access to the selected repository.
2. **GitHub ingestion:** Manually sync at most 50 recent commits and 100 issues per configured sync, with bounded per-item and aggregate content. Do not import public repositories outside a verified GitHub App connection. No webhooks initially.
3. **Source retention and provenance:** Preserve immutable historical source revisions referenced by findings, contradiction candidates, or handovers. Unlinking stops future sync but does not remove referenced evidence.
4. **Contradiction handling:** AI creates candidates only. Human confirmation is required. Only confirmed conflicts may appear in a separate handover section with supporting evidence and reviewer rationale.
5. **Assignments:** Preserve owner/editor/viewer project roles. Reviewer and approver assignments are separate and do not grant editor permissions. Existing projects keep legacy behavior until an owner opts in; new projects use assigned workflow. The handover creator cannot approve their own version.
6. **Sign-off:** One approval is sufficient. Any rejection is terminal for that version and requires a reason. Sign-off is append-only and tied to the exact immutable handover version; no sign-off carries forward.
7. **Superseded versions:** Older pending sign-offs become ineligible through computed superseded status. Do not rewrite historical stored status. An outdated pending version cannot approve the latest version.
8. **Deletion recovery and retained metadata:** Provide a 30-day recovery window, then purge content through retryable cleanup. Retain only the enumerated audit/sign-off metadata after content purge, for a configurable duration.
9. **Deletion processing:** Use a scheduled, retryable background processor with bounded batches; do not depend on an open browser.
10. **Audit access and retention:** Restrict audit history to project owners and explicitly assigned audit readers. Audit retention duration is configurable.

**Phase 4 clarifications approved 2026-11-17:** Issue selection is the latest 100 updated issues across all states, excluding pull requests; no issue comments. Approved limits are 2 MiB raw response per response, 8 MiB aggregate normalized content per sync, README 256 KiB, commit message 8 KiB each/256 KiB aggregate, and issue title/body 16 KiB each/1 MiB aggregate. Scan at most five pages of 100 raw issue entries; report actual count and mark partial if the cap prevents reaching 100. Provider timeout is 10 seconds. The 45-second server-owned sync deadline is allowed only if the deployed function maximum is at least 60 seconds; otherwise use no more than 75% of the verified maximum. The checked-in `server/vercel.json` sets `maxDuration` to 300 seconds, but the live project root/dashboard/runtime must be verified before implementation. Sync is synchronous, owner-initiated, checkpointed, and retried explicitly by an owner; no worker, webhook, or schedule. Do not automatically start AI analysis. Retain old findings with exact revision provenance without auto-staling. Reject direct GitHub source deletion; preserve historical sources/revisions. Use the existing SourceRevision-to-Source-to-ProjectRepository provenance chain unless implementation proves a direct reference necessary. Refresh installation status when stale and verify repository access during sync. See [ROUND3_PHASE4_IMPLEMENTATION_PLAN.md](ROUND3_PHASE4_IMPLEMENTATION_PLAN.md) for lease, pagination, migration, and analysis-integration requirements.

**Other operational configuration still required before production:** set the post-purge metadata retention duration. Before Phase 4 rollout, verify the deployed Vercel project uses the checked-in server config and confirm its effective function limit supports the 45-second app deadline; otherwise use a lower deadline with cleanup margin.
