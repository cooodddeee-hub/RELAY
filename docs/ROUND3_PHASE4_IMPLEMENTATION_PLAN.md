# RELAY Round 3 Phase 4 — GitHub Ingestion Implementation Plan

**Status: Phases 4A–4E implemented; production migrations and deployed runtime verification remain release gates**
**Scope:** Manual GitHub README, commit, and issue ingestion; immutable source revisions; resumable sync jobs; existing per-source AI analysis integration.
**Out of scope:** Webhooks, background workers, scheduled sync, issue comments, commit diffs, combined multi-source analysis, and automatic finding staleness.

The implementation is a bounded synchronous owner-triggered sync with persisted checkpoints and explicit retry; it does not use a worker. GitHub analysis is revision-pinned at job creation and uses that immutable snapshot on retries. Both ingestion and revision-aware analysis are implemented; production migrations and effective deployed function limits remain unverified.

This document records the approved Phase 4 contract and implementation sequence. The current source tree implements bounded GitHub provider retrieval, persisted sync and recovery, immutable revisions, revision-pinned analysis, and the frontend workflow. Integration tests exercise the isolated local replica set; no shared/production migration has run, and the deployed Vercel root/runtime still requires verification. Read it with [the architecture decisions](ROUND3_ARCHITECTURE_DECISIONS.md), [the implementation plan](ROUND3_IMPLEMENTATION_PLAN.md), [Phase 3 migration notes](ROUND3_PHASE3_MIGRATION.md), [Phase 4A migration notes](ROUND3_PHASE4A_MIGRATION.md), and [GitHub App setup](GITHUB_APP_SETUP.md).

## Approved product decisions

- Import the latest 100 updated issues across all states, excluding pull requests.
- Do not ingest issue comments in Phase 4.
- Maximums: README 256 KiB; commit message 8 KiB each and 256 KiB aggregate; issue title/body 16 KiB each and 1 MiB aggregate.
- Enforce a 2 MiB raw HTTP response byte limit before JSON parsing.
- Enforce an 8 MiB aggregate normalized content limit per sync, in addition to the stricter per-category caps below.
- Sync is synchronous, bounded, manually initiated by a current project owner, and persisted as a job with checkpoints. Retry requires an explicit owner request. There is no worker, webhook, or schedule.
- Keep old findings with their original revision provenance. Do not automatically label them stale in Phase 4.
- Reject direct deletion of GitHub sources in Phase 4. Preserve all GitHub sources and revisions; repository unlinking stops future sync but does not delete history.
- Provenance uses `SourceRevision → Source → ProjectRepository`. Add a direct link reference only if implementation proves the existing chain insufficient.
- Refresh installation status when stale and verify repository access during sync.

## Current implementation constraints

- `ProjectRepository` has a stable ID and `active`/`unlinked` lifecycle. Relinking creates a new ID.
- `Source` already has `provider`, `externalType`, `repositoryLink`, `externalId`, `externalUrl`, `externalUpdatedAt`, and `currentRevision`, plus upload-specific fields.
- `SourceRevision` already has immutable `revisionKey`, `contentHash`, `textSnapshot`, `providerUpdatedAt`, `capturedAt`, and `locator`; `{ source, revisionKey }` is unique.
- GitHub API retrieval is bounded before JSON parsing and normalized content is capped across an entire sync. Sync persistence uses source/revision uniqueness and persisted checkpoints.
- `AnalysisJob` snapshots selected GitHub source revision IDs/keys. Workers analyze the pinned `SourceRevision.textSnapshot`; findings retain optional revision evidence without changing legacy upload evidence.
- `createOrGetAnalysisJob` selects processed sources based on `analysisCompletedAt`. A GitHub source with a newer revision would otherwise remain ineligible after the first successful analysis.
- Source routes include upload-oriented download and delete behavior. GitHub sources must not be treated as local files or physically removed by upload cleanup logic.
- Analysis advances through explicit API calls and uses leases; there is no general background worker. Phase 4 must not add one.

## Data model and invariants

### New `GitHubSyncJob`

Proposed fields:

```text
project, repositoryLink, installation, requestedBy
status: running | partial | retry_wait | completed | failed
stage: refresh_installation | readme | commits | issues | finalize
checkpoints: per-category status, cursor/page, counts, last completed batch
attemptCount, retryAt, retryable, lastErrorCode
startedAt, completedAt, lastProgressAt
leaseToken, leaseExpiresAt
createdAt, updatedAt
```

Counts and public errors must be safe metadata only. Do not persist raw GitHub responses, issue/commit content in the job, credentials, tokens, callback state, or provider exception messages. Source text belongs in `SourceRevision`.

Use atomic job claiming with a lease and an active-job uniqueness guard for each repository link. One concrete design is `active: true` on nonterminal jobs and a unique partial `{ repositoryLink, active }` index. Claim/reclaim must be a conditional `findOneAndUpdate`, not a read followed by a write. On a duplicate active job, return its status rather than create a second job.

When a lease expires, a subsequent owner retry/status request must atomically convert the abandoned running job to resumable state and claim it. Status projection should identify an expired lease as interrupted/retryable even before a retry arrives. No permanent lock may depend on a worker to clear it.

### Existing `Source` and `SourceRevision`

Create one stable Source per GitHub object, keyed by the existing unique identity `{ provider, repositoryLink, externalType, externalId }`:

- README: external ID is its repository path; revision key is the Git blob SHA (plus path if needed).
- Commit: external ID and revision key use commit SHA.
- Issue: external ID is issue number; revision key uses the captured issue update marker plus content hash.

For each new revision, create a new immutable `SourceRevision`; never update an existing revision’s text or metadata. Update `Source.currentRevision`, `externalUpdatedAt`, and the text used by existing APIs only after the new revision is committed. Use a transaction for the source/revision/current-pointer/checkpoint update. Unique-index races must reread the winner and continue idempotently.

Set GitHub sources to a state compatible with existing processed-source analysis. Do not require GitHub documents to have local file paths. Keep the current normalized relation `SourceRevision.source → Source.repositoryLink → ProjectRepository`; historical repository links are tombstones, not deletions.

Add an analysis watermark such as `Source.analyzedRevision` or an equivalent persisted revision key. A GitHub source is eligible for analysis when its current revision differs from its analyzed revision. Existing uploaded sources continue to use `analysisCompletedAt`.

Sync does not implicitly start AI analysis or create an `AnalysisJob`. Preserve the existing explicit project analysis action and permission rules. When that action runs, it should reuse an active project analysis job and pin each selected GitHub source revision once; retries of sync itself must never create analysis jobs. If a newer revision arrives while an older analysis job is active, that job keeps its pinned snapshot and the newer revision remains eligible for a subsequent analysis request.

### Analysis job snapshot and finding evidence

Add an optional per-source revision snapshot to new `AnalysisJob` records, for example `{ sourceId, revisionId }[]`. Legacy jobs containing only `sourceIds` remain valid. For pinned GitHub sources, analysis must load the saved `SourceRevision.textSnapshot`, never a later value from `Source.extractedText`.

Extend finding evidence additively with `sourceRevision` and locator fields. Include revision identity in GitHub finding idempotency keys, so analysis retries for one revision deduplicate while a later revision can produce a new pending finding. Do not modify previous findings or review decisions. Keep existing upload evidence and finding keys readable.

## API design

All routes require authentication. IDs and project scope are validated server-side.

| Endpoint | Permission | Behavior |
| --- | --- | --- |
| `POST /api/projects/:id/github/repositories/:linkId/sync` | Current project owner | Validate active link and installation; atomically create/claim a persisted sync job; execute the bounded sync synchronously; return job ID and public progress/status. |
| `GET /api/projects/:id/github/sync-jobs/:jobId` | Project member | Return safe job status/counts and retry eligibility, scoped by both project and job. |
| `POST /api/projects/:id/github/sync-jobs/:jobId/retry` | Current project owner | Reclaim an expired lease or resume a retryable/partial job from its saved checkpoints. Reject terminal success and nonretryable states. |
| `GET /api/projects/:id/sources/:sourceId/revisions` | Project member | Return ordered revision metadata and provenance; bound page size. Avoid returning all historical text by default. |

The sync endpoint must not use the browser request’s `AbortSignal` or `req.close` event to cancel provider calls or persistence. A disconnected browser may lose the response, but the server-owned job continues until its deadline or serverless runtime termination. The handler must not attempt a response write after the response has closed; durable job processing and response delivery are separate concerns. The owner can later query job status. A repeat request must reconcile with the active job, and unique source/revision keys make a completed or partially completed rerun safe.

Do not trust the `linkId` alone. Every source, job, revision, and retry query must include `project`; verify the link’s project matches the route project. Reviewer/approver assignment does not grant sync permission. Existing uploaded-source permission behavior remains unchanged.

## Provider calls, pagination, bounds, and timeout

### Item and aggregate limits

Enforce approved decoded/normalized content limits before saving:

- README text: 256 KiB.
- Commit message: 8 KiB each, 256 KiB aggregate, maximum 50 commits.
- Issue title/body: 16 KiB each, 1 MiB aggregate, maximum 100 non-PR issues.
- No issue comments or commit diffs.

Use UTF-8 byte accounting and deterministic safe truncation. Record a truncation flag/length in revision locator metadata and UI. Never claim truncated content is complete.

### Raw response limits

The `githubApp` HTTP layer must enforce the approved 2 MiB byte limit while reading each response stream, before JSON parsing. Checking `Content-Length` alone is insufficient. Reject oversized responses with a stable safe error code and no partial JSON persistence. Independently enforce the approved 8 MiB total normalized content limit across all revisions captured by one sync. Page-count and request-count ceilings also bound raw transfer; do not conflate the content budget with response bytes.

### Pagination

- Commits: query the current default branch, newest first, `per_page=50`; never request or persist more than 50 commit records.
- Issues: query all states ordered by `updated` descending; exclude entries with `pull_request`; stop once 100 actual issues have been captured or the repository is exhausted.
- Bound both issue page count and total raw API objects scanned. Persist page cursor and scanned/captured counts after each page. Do not continue unbounded pagination when pull requests dominate results.
- The approved issue scan is at most five pages of 100 raw entries (500 raw entries maximum) and at most 100 qualifying issues. If the repository is exhausted before the scan cap, return a complete result with the actual qualifying issue count. If the five-page cap is reached while another page may contain qualifying issues and fewer than 100 were captured, return a partial result with the actual count and `issue_scan_limit_reached`; never imply the latest 100 were all imported.
- README access uses the GitHub API and repository identity; do not fetch provider-returned arbitrary URLs.

### Strict synchronous deadline and recovery

Use a server-owned 45-second absolute deadline established when the job is claimed. Each GitHub provider request has a hard 10-second timeout and also cannot exceed the remaining job budget. Check the overall deadline before every provider call, persistence batch, and stage transition. The checked-in [server/vercel.json](../server/vercel.json) configures `maxDuration: 300` seconds for both `server.js` and `src/app.js`, so 45 seconds is below the repository-configured function limit and leaves 255 seconds for runtime/cleanup headroom. Before implementation rollout, verify the deployed Vercel project actually uses this `server` root/config and that its dashboard/plan/runtime does not set a lower effective limit. If the effective maximum is below 45 seconds, set the application deadline to at most 75% of that limit, leaving at least 25% for cleanup and response. Vercel documents that functions are terminated when their configured maximum duration is exceeded ([function duration configuration](https://vercel.com/docs/functions/configuring-functions/duration)).

On ordinary timeout, transition the job transactionally to `partial`/`retry_wait`, persist the current checkpoint, set a safe retry time, and release the lease. On process termination or host timeout, the lease expires; the next owner request reports/reclaims the interrupted job. The request’s client disconnect must not clear the job or cancel the server-owned operation. No timer or background process is introduced.

## Sync lifecycle and transaction boundaries

1. **Claim:** In a transaction, recheck `Project.owner`, require `ProjectRepository.status === active`, confirm link/project identity and installation authorization, atomically acquire the active job/lease, and append `github.sync.started` audit metadata.
2. **Refresh authorization:** Refresh installation status only when its stored verification is stale. During sync, verify the installation can access the linked repository by stable repository ID. Treat suspended/removed/inaccessible as safe terminal or retryable status according to the provider response; never continue ingestion after access is denied.
3. **Fetch:** Fetch bounded categories in a fixed order. Store only cursors/counts/checkpoints. Installation tokens stay in server memory and are never returned or logged.
4. **Persist category batches:** In a transaction, recheck current project owner and active link, write Sources/revisions/current pointers, advance checkpoint, and append safe progress metadata. If unlink or ownership transfer wins while GitHub is responding, discard that not-yet-persisted response.
5. **Finish/fail:** In a transaction, update the terminal/partial state, release active lock, and append a completion/partial/failure audit event with only safe counts and codes.
6. **Retry:** Require current owner, reclaim only after retry timing/lease rules, and skip completed categories/pages. Re-fetching a page after a crash is safe because source/revision uniqueness makes persistence idempotent.

All Mongo writes that grant/continue sync authority must serialize with Phase 3 owner changes and unlink writes. Audit events and the state change they describe commit atomically.

## Source routes and deletion compatibility

The existing source download route assumes local or Supabase storage. For GitHub sources, return the captured text through the authorized content endpoint and do not attempt file download. The existing editor delete route must not physically remove a GitHub Source or SourceRevision. Recommended Phase 4 policy: reject direct deletion of GitHub sources and require repository unlink; if UI needs hiding, add a separate archive state that preserves source/revision/evidence records. Archive must not erase provenance or make pinned evidence unreadable.

Reject `DELETE /api/sources/:sourceId` for GitHub sources with a clear response; do not archive or physically delete them in Phase 4. Repository unlinking is the supported way to stop future capture. Uploaded-source upload, extraction, download, and deletion remain unchanged. Existing evidence without a revision reference remains valid. Do not silently backfill source revisions for uploads.

## Dependency-ordered phases and acceptance criteria

### 4A — Schema and migration preflight (implemented)

Add `GitHubSyncJob`, active lock/index, additive analysis snapshots/watermark, schema/index tests, and an idempotent duplicate-preflight migration. The approved bounds are documented and deployment runtime verification remains a pre-rollout gate.

**Acceptance evidence:** Active-job exclusivity passed the isolated Mongo replica-set concurrency test; duplicate callers reconcile to one active job; terminal jobs release the unique slot; migration ran twice successfully against `relay_round3_test`; migration duplicate/target preflight unit tests pass; schema tests verify additive fields while legacy upload/job/finding documents still validate. No production/shared migration was run. Live Vercel project settings remain unverified.

### 4B — Bounded provider layer and canonical text

Add commit/issue/README readers, stream-based response byte limits, pagination limits, installation refresh/access verification, normalizers, revision keys, hashes, and safe rate-limit errors.

**Accept when:** request counters prove the 50-commit and five-page/500-raw-issue-entry ceilings; response streams are aborted/rejected before JSON parsing after 2 MiB; the 8 MiB normalized aggregate and all per-item/category caps are enforced; exhausted repositories report their actual issue count as complete, while scan-cap-limited results under 100 issues are marked partial with actual count; unsupported/oversized content yields explicit safe status.

### 4C — Synchronous persisted sync and resume

Add owner-only start/retry, member status, atomic job lease, hard deadline, per-page/category checkpoints, immutable source/revision persistence, audit events, and active-link/owner rechecks.

**Accept when:** normal completion releases the lease; timeout and injected process interruption cannot strand a permanent lock; two concurrent requests produce one active job; disconnecting the HTTP client does not cancel/corrupt the job; retry resumes from saved checkpoints with no duplicate Sources/revisions; unlink or owner transfer during fetch blocks the uncommitted batch.

### 4D — Pin revisions in existing analysis

Add job revision snapshots, analyze exact immutable snapshots, add evidence revision/locator fields, use revision-aware deduplication, and track the analyzed revision. Retain existing uploaded-source logic.

**Accept when:** analysis uses the pinned snapshot after the Source current pointer changes; a retry does not create duplicate findings/jobs for the same revision; a new revision is eligible for one new analysis; old findings remain unchanged; upload-only and mixed legacy/new job fixtures pass.

### 4E — UI, docs, and release readiness

Add owner sync control, persisted status/progress, explicit retry, partial/truncated labels, source revision history/provenance, and safe behavior for GitHub source download/delete. Update API, setup, architecture, known limitations, demo, and migration docs.

**Accept when:** the UI never reports partial imports as complete; browser disconnect/reload can recover from status endpoint; no GitHub token or credential is present in client state/responses; docs distinguish implemented Phase 3 from planned Phase 4 until release.

## Test strategy

- Unit: canonical text and hashes; byte/character limits; safe Unicode truncation; revision keys; raw response reader; rate-limit mapping; deadline transitions; lease expiry/reclaim; public job projection.
- Mock provider: latest updated ordering, all issue states, PR exclusion, multiple pages, page/object limits, empty README, huge README/body, huge raw JSON, malformed JSON, rename/transfer by ID, inaccessible/suspended/removed install, expired token, 403/429 rate limit, timeout, and network failure.
- Isolated Mongo integration: active job race across concurrent requests; source/revision uniqueness; repeated sync; changed README/issue; partial checkpoint retry; transaction rollback; abandoned lease reclaim; owner transfer/unlink during provider delay; audit atomicity; preserved tombstone provenance.
- Disconnect: close the client connection after claim, then assert job reaches a durable checkpoint or terminal/retryable state and a later GET returns it.
- Analysis regression: pinned revision remains stable after sync advances Source; evidence points to pinned SourceRevision; same revision retry deduplicates; new revision creates a new analysis opportunity; legacy upload/job records remain processable.
- Security: owner-only start/retry; members only read in-project status/content; assignment roles do not grant sync; cross-project IDOR rejection; token/credential/content redaction.
- Release: full backend tests against isolated replica set, backend checks, JavaScript syntax, frontend production build, and `git diff --check`. Never run migrations against shared/production data as part of local tests.

## Migration and backward compatibility

Proposed new migration: `server/scripts/migrations/phase4-github-sync-indexes.js`.

1. Run against a disposable copy first; migration must verify the intended database identity and refuse production/shared targets unless explicitly invoked through an approved procedure.
2. Preflight duplicate GitHub Source identities and duplicate `{ source, revisionKey }` records. Report counts/IDs without deleting or rewriting history.
3. Ensure the existing partial Source unique index and SourceRevision unique index exist; create sync-job indexes, including the partial active-job uniqueness rule.
4. Add no mandatory fields to existing uploads/findings/jobs. New `sourceRevision`, locator, revision watermark, and job snapshot fields are optional.
5. Preserve legacy `analysisCompletedAt` behavior for uploads; only GitHub sources use the revision watermark.
6. Deploy indexes before code relies on them. Do not run production/shared migrations in Phase 4 implementation/testing without a separately approved migration operation.

## Remaining risks and implementation gates

1. **Vercel deployment configuration:** the checked-in backend function config is 300 seconds and supports the implemented 45-second sync deadline. The actual Vercel project root, dashboard overrides, plan, and deployed runtime are not verified from this checkout. Confirm the deployed effective maximum is at least 45 seconds (and allow response/cleanup headroom) before relying on that deadline in production.
2. **Serverless process termination:** Vercel can terminate an invocation at its effective maximum. The lease/checkpoint design prevents permanent locks and duplicate data, but a killed invocation may require explicit owner retry and may refetch an incomplete page.
3. **Issue scan cap:** the approved five-page budget can return fewer than 100 issues when pull requests dominate or more pages exist. Report actual count; mark partial only when the scan cap, rather than repository exhaustion, stopped collection before 100.
4. **Revision-pinned analysis is implemented.** New explicit jobs snapshot GitHub source revisions; workers use only the pinned immutable revision text, including retries. Missing/mismatched pinned revisions fail safely. Existing uploads and legacy sourceIds-only jobs retain their compatibility path.
5. **AI input budget:** analysis sends at most 45,000 characters per source. Larger approved ingestion snapshots are stored, but analysis and evidence verification use the same capped input excerpt; evidence outside the sent excerpt cannot be verified.
6. **Old findings after updates:** they remain visible with original evidence; UI must distinguish their source revision. Automatic stale marking remains deferred.
7. **Automatic analysis after sync:** approved behavior is no automatic analysis. Preserve the existing explicit analysis action and permissions; sync retries must not create analysis jobs.

The approved byte/content caps and deadlines above are enforced application constants. They are not deployment environment variables. Retention values, provider credentials, callback URLs, and runtime deployment settings remain deployment configuration.
