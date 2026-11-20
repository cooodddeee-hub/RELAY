# RELAY API Reference

This reference was checked against `server/src/app.js`, all route modules in `server/src/routes/`, authorization middleware, service validation, and Mongoose models. It documents the current implementation; it is not a promise of an independently deployed API contract.

## Base URL and common behavior

The backend listens on `PORT` or defaults to `5001`; the local API base is `http://127.0.0.1:5001/api`. Vite proxies `/api` to `http://127.0.0.1:5001`.

Unless specified otherwise, endpoints require:

```http
Authorization: Bearer <JWT>
```

JSON endpoints accept `Content-Type: application/json`. The Express JSON parser has a 2 MB limit. Uploads use `multipart/form-data`.

`GET /api/health`, the state-protected GitHub setup/OAuth callbacks, and the `CRON_SECRET`-protected internal cleanup route do not use a RELAY user JWT. Other application routes require one. The API applies Helmet, configured CORS, a global rate limit of 300 requests per 15 minutes, plus dedicated login limits (10 per 15 minutes per IP) and registration limits (5 per hour per IP). The global error handler returns `{ "message": "Internal server error" }` for errors with status 500 or higher; lower-status errors use `{ "message": "..." }` when the error has a message. Some route-specific responses below are returned directly.

Project role shorthand used below:

- **Member**: project owner, editor, or viewer.
- **Editor**: project owner or editor.
- **Owner**: project owner only.

Query parameters are listed for routes that accept them. IDs in paths are MongoDB ObjectIds unless a route specifies GitHub's numeric ID. Project, finding, source, and handover access is checked on the backend.

## Round 3 workflows

Round 3 endpoints are listed below with their route-mounted paths. All `/api/projects/...` operations require a JWT. `Member`, `Editor`, and `Owner` have the meanings defined above. Assignment roles are independent from editor permissions. Provider credentials are never returned to clients.

### GitHub App, repositories, and sync

| Method and path | Access | Success | Important errors/behavior |
| --- | --- | --- | --- |
| `GET /api/integrations/github/setup` | GitHub callback; no RELAY JWT | `302` to GitHub OAuth after consuming valid setup state and verifying installation | `400` invalid/expired/replayed state or unsupported action; `403` initiating actor no longer owns project; `409` suspended installation; `503` GitHub not configured |
| `GET /api/integrations/github/oauth/callback` | GitHub callback; no RELAY JWT | `302` back to the original frontend project with a safe outcome query | `400` invalid/expired/replayed state; callback failures redirect with safe outcome; temporary user token is revoked before persisting authorization |
| `POST /api/projects/:id/github/installations/start` | Owner | `201 { installationUrl }` | `403` non-owner; `503` integration not configured |
| `POST /api/projects/:id/github/installations/authorize` | Owner | `201 { authorizationUrl }` for existing installations | `403` non-owner; `503` integration not configured |
| `GET /api/projects/:id/github/installations` | Owner | `200 { installations: [...] }` with account identity and status/verification summary | `403` non-owner; stale status is exposed as unverified/needs verification rather than asserted active |
| `GET /api/projects/:id/github/repositories` | Member for linked metadata; Owner when `installationId` is supplied | `200 { repositories: [...] }` or empty list | With `installationId`, optional `page` is 1–10 and installation access is refreshed; `400` invalid page; `403` discovery by non-owner; `404` unauthorized installation; `409` suspended installation |
| `POST /api/projects/:id/github/repositories` | Owner | `201 { repository }` | Body `{ installationId, repositoryId }`; `400` invalid IDs; `404` inaccessible repository/installation; `409` already linked; linking is explicit |
| `DELETE /api/projects/:id/github/repositories/:linkId` | Owner | `200 { message }` | Soft-unlinks the active link; preserves link identity/provenance; `404` no active link |
| `POST /api/projects/:id/github/repositories/:linkId/sync` | Owner | `201 { job }` for a new job, `202 { job }` while running, or `200 { job }` for an existing completed result | `400` invalid link ID; `403` non-owner; `409`/other safe service error for conflict or unavailable sync; manual synchronous bounded request, no automatic AI analysis |
| `GET /api/projects/:id/github/sync-jobs/:jobId` | Member | `200 { job }` | `403` cross-project/no access; status includes persisted stage, checkpoint, counts and retry metadata |
| `POST /api/projects/:id/github/sync-jobs/:jobId/retry` | Owner | `200 { job }` or `202 { job }` while running | `403` non-owner; safe service error for non-retryable/conflicting job |

GitHub provider failures use sanitized messages and safe codes; rate-limit responses may include `Retry-After`. The callback state is one-time, purpose-bound, project/actor-bound, and expiring.

### Assignments, workflow policy, and audit

| Method and path | Access | Success | Important errors/behavior |
| --- | --- | --- | --- |
| `GET /api/projects/:id/assignments` | Member | `200 { assignments, canManageAssignments }` | Owners see history; other members see active assignments |
| `POST /api/projects/:id/assignments` | Owner | `201 { assignment }` | Assign reviewer, approver, or audit-reader scope; `400` invalid body/scope; `403` non-owner; `409` duplicate active assignment or invalid target |
| `POST /api/projects/:id/assignments/:assignmentId/revoke` | Owner | `200 { assignment }` | Optional reason up to 1,000 chars; revoked history retained; `404` inactive/missing assignment |
| `POST /api/projects/:id/assignments/:assignmentId/reassign` | Owner | `201 { assignment }` | Revoke and replacement assignment are atomic; reason optional, up to 1,000 chars |
| `PATCH /api/projects/:id/workflow-policy` | Owner | `200 { workflowPolicy }` | Body contains `reviewMode` (`legacy_editors`/`assigned`) and/or `signoffMode` (`none`/`assigned`); assigned mode requires an active corresponding assignment; invalid mode `400`, absent assignment `409` |
| `GET /api/projects/:id/audit-events?limit=50` | Owner or assigned audit reader | `200 { events }` (default 50, maximum 100) | `403` unauthorized audit reader; invalid limit `400`; retention expiry is configured server-side |

New projects default to assigned review and signoff. Existing projects retain legacy behavior until an owner changes policy.

### Contradiction candidates

| Method and path | Access | Success | Important errors/behavior |
| --- | --- | --- | --- |
| `GET /api/projects/:id/contradictions?status=...` | Member | `200 { candidates }` | Optional status filter; invalid status `400` |
| `POST /api/projects/:id/contradictions/detect` | Owner/editor | `200 { detectedPairs, createdCount, candidates }` | Request body must be empty; detection only proposes cautious evidence-backed candidates and never confirms them; duplicate race `409` |
| `POST /api/projects/:id/contradictions/:candidateId/review` | Assigned reviewer in assigned mode; owner/editor in legacy mode | `200 { candidate }` | Body `{ status, reason }`; reason required (1–2,000 chars); only human transitions confirm/dismiss; unauthorized reviewer `403`, invalid transition/input `400`/`409` |
| `GET /api/projects/:id/contradictions/:candidateId/history` | Owner or assigned audit reader | `200 { events }` | `403` if audit access is not granted; `404` candidate not found |

Only candidates in `confirmed_conflict` state are included in a newly generated handover, with their evidence and reviewer rationale. This detector is limited to supported evidence-backed patterns and is not general-purpose semantic contradiction detection.

### Handover versions and signoff

| Method and path | Access | Success | Important errors/behavior |
| --- | --- | --- | --- |
| `POST /api/projects/:id/handover` | Owner/editor | `201 { handover }` | `approvalStatus` is `pending` when assigned signoff is enabled, otherwise `draft`; includes approved findings and confirmed conflicts; lock contention `409` |
| `GET /api/projects/:id/handovers` | Member | `200 { handovers }` | Includes computed `effectiveStatus`; a pending older version becomes `superseded` when a newer version exists |
| `GET /api/handovers/:handoverId` | Member of project | `200 { handover }` | Includes computed `effectiveStatus`; project in deletion lifecycle `410` |
| `POST /api/handovers/:handoverId/signoffs` | Active assigned approver; creator excluded | `201 { signoff }` | Body `{ decision: "approved"|"rejected", comment, reason? }`; comment required, rejection reason required; disabled workflow `409`, unauthorized/self-approval/superseded version `403`/`409`, duplicate terminal decision `409` |
| `GET /api/handovers/:handoverId/signoffs` | Member of project | `200 { signoffs, effectiveStatus }` | Signoff records are append-only and tied to exact handover ID/version |
| `GET /api/handovers/:handoverId/download` | Member of project | `200` PDF attachment | Renders the stored immutable snapshot; does not regenerate it |

One approval is sufficient. Any rejection is terminal for that version; a new handover version requires its own decision.

### Project deletion and recovery

| Method and path | Access | Success | Important errors/behavior |
| --- | --- | --- | --- |
| `DELETE /api/projects/:id` | Owner | `202 { message, deletion: { state, requestedAt, recoveryEndsAt, jobId } }` | Tombstones/freezes access; recovery window is 30 days; audit retention configuration failure `503` |
| `GET /api/projects/:id/deletion` | Owner | `200 { deletion: { ..., recoveryEndsAt, job } }` | `404` if no owner-visible deletion request |
| `POST /api/projects/:id/deletion/cancel` | Owner | `200 { message, project: { id, deletionState } }` | Cancels only during recovery period before purge starts; late recovery is rejected |
| `GET /api/internal/project-deletions/process` | Vercel cron bearer (`CRON_SECRET`), no user JWT | `200 { processedProjects, batches, results }` | `401` invalid bearer; `503` secret not configured; processes bounded retryable cleanup batches |

### GitHub source deletion

`DELETE /api/sources/:sourceId` requires an editor, but returns `409` for GitHub-imported sources because source/revision provenance is retained. Unlink its repository to stop future sync. Uploaded sources retain their existing deletion behavior.

## Authentication

Mounted at `/api/auth`. Registration and login are public. Tokens are JWT bearer tokens that expire after 12 hours; the frontend stores them in local storage.

### `POST /api/auth/register`

Create an account and issue a token.

- **Auth:** Not required.
- **Body:** `name` (string, required, trimmed, maximum 100 characters); `email` (valid email string, trimmed and lowercased); `password` (string, 8–128 characters).
- **Success:** `201` — `{ "token": "<JWT>", "user": { "id": "...", "name": "...", "email": "..." } }`.
- **Errors:** `400` invalid name/email/password or model validation; `409` email already registered; otherwise global error response.

### `POST /api/auth/login`

Verify credentials and issue a token.

- **Auth:** Not required.
- **Body:** `email` (valid email string); `password` (non-empty string).
- **Success:** `200` — same `{ token, user }` shape as registration.
- **Errors:** `400` invalid/missing input; `401` incorrect email or password; otherwise global error response.

### `GET /api/auth/me`

Return the current authenticated user for session restoration.

- **Auth:** Required.
- **Success:** `200` — `{ "user": { "id": "...", "name": "...", "email": "..." } }`.
- **Errors:** `401` missing, invalid, or expired bearer token, or user no longer exists.

## Projects

Mounted at `/api/projects`; all routes require authentication.

### `GET /api/projects`

List projects owned by or shared with the current user.

- **Auth:** Required.
- **Authorization:** Returns only projects matching owner or member user ID.
- **Success:** `200` — `{ "projects": [...] }`; each item is a serialized Project document. The route does not apply a field projection.
- **Errors:** Global error response on database failure.

### `POST /api/projects`

Create a project owned by the current user.

- **Auth:** Required.
- **Body:** `name` (required); `description` (optional, defaults to empty string). The handler does not define additional body fields.
- **Success:** `201` — `{ "project": <serialized Project document> }`. The authenticated user is stored as owner and also receives an owner membership entry.
- **Errors:** `400` when the project name is missing; otherwise global error response.

### `GET /api/projects/:id`

Retrieve one project.

- **Auth:** Required.
- **Authorization:** Member.
- **Path:** `id` — project ObjectId.
- **Success:** `200` — `{ "project": <serialized Project document> }`.
- **Errors:** `400` invalid ID; `403` not a member; `404` project not found; otherwise global error response.

### `PUT /api/projects/:id`

Update project fields.

- **Auth:** Required.
- **Authorization:** Editor.
- **Path:** `id` — project ObjectId.
- **Body:** Any of `name`, `description`, `status`; omitted fields retain their existing value. `status`, when provided, is subject to the Project model enum: `active`, `review`, or `completed`.
- **Success:** `200` — `{ "project": <serialized Project document> }`.
- **Errors:** `400` invalid ID; `403` viewer/non-member; `404` not found; validation/database errors use the global error handler.

### `DELETE /api/projects/:id`

Request project deletion and enter its recovery lifecycle.

- **Auth:** Required.
- **Authorization:** Owner only.
- **Path:** `id` — project ObjectId.
- **Body:** None consumed.
- **Success:** `202` — `{ "message": "Project access is frozen. Recovery is available for 30 days before cleanup.", "deletion": { "state", "requestedAt", "recoveryEndsAt", "jobId" } }`.
- **Errors:** `400` invalid ID; `403` non-owner; `404` not found; otherwise global error response.
- **Behavior:** The route starts the owner-authorized tombstone/recovery lifecycle and returns `202`; it does not synchronously erase project records. Cleanup is performed by the authenticated scheduled processor after the recovery period.

## Project members

These routes are mounted under `/api/projects/:id/members` and require authentication.

### `GET /api/projects/:id/members`

List owner and member identities and roles.

- **Auth:** Required.
- **Authorization:** Member.
- **Path:** `id` — project ObjectId.
- **Success:** `200` — `{ "members": [{ "memberId": "...", "user": { "id": "...", "name": "...", "email": "..." }, "role": "owner|editor|viewer" }], "canManageMembers": boolean }`.
- **Errors:** `400` invalid project ID; `403` not a member; `404` project not found; otherwise global error response.

### `POST /api/projects/:id/members`

Add an existing RELAY account to the project.

- **Auth:** Required.
- **Authorization:** Owner only.
- **Path:** `id` — project ObjectId.
- **Body:** `email` (registered user’s email; normalized to lowercase); `role` (`editor` or `viewer`).
- **Success:** `201` — `{ "member": { "memberId": "...", "user": { "id": "...", "name": "...", "email": "..." }, "role": "editor|viewer" }`.
- **Errors:** `400` invalid email or role; `403` caller is not owner; `404` no registered account for email; `409` user already belongs to project or is the owner; otherwise global error response.
- **Behavior:** No email is sent. Duplicate membership is guarded by a conditional database update.

### `PATCH /api/projects/:id/members/:memberId`

Change a member’s role.

- **Auth:** Required.
- **Authorization:** Owner only.
- **Path:** `id` — project ObjectId; `memberId` — member user ObjectId.
- **Body:** `role` (`editor` or `viewer`).
- **Success:** `200` — `{ "member": { "memberId": "...", "user": { "id": "...", "name": "...", "email": "..." }, "role": "editor|viewer" }`.
- **Errors:** `400` invalid member ID, invalid role, or attempt to change owner role; `403` caller is not owner; `404` member/account not found; otherwise global error response.

### `DELETE /api/projects/:id/members/:memberId`

Remove a project member.

- **Auth:** Required.
- **Authorization:** Owner only.
- **Path:** `id` — project ObjectId; `memberId` — member user ObjectId.
- **Body:** None consumed.
- **Success:** `200` — `{ "message": "Member removed from project." }`.
- **Errors:** `400` invalid member ID or attempt to remove owner; `403` caller is not owner; `404` member not found; otherwise global error response.

## Sources and uploads

All source routes are mounted under `/api` and use authentication middleware. Source reads require project membership; upload and delete require owner/editor access.

### `POST /api/projects/:id/sources`

Upload and extract a source document.

- **Auth:** Required.
- **Authorization:** Editor.
- **Path:** `id` — project ObjectId.
- **Request:** `multipart/form-data`, one file in field `file`. Accepted filename extensions: `.pdf`, `.docx`, `.txt`, `.md`. Maximum size is 15 MiB (15 × 1024 × 1024 bytes).
- **Success:** `201` — `{ "source": { "_id": "...", "originalName": "...", "status": "processed", "extractedCharacters": number } }` when local-disk uploads are enabled.
- **Errors:** `410` when local-disk uploads are disabled (including production); `400` missing/invalid file; `403` caller lacks editor access; extraction/database errors use the global handler.
- **Behavior:** This is the legacy local-disk upload path. Production should use the signed Supabase upload-intent workflow below. Maximum file size is 15 MiB; accepted extensions are PDF, DOCX, TXT, and MD.

### `POST /api/projects/:id/sources/upload-intent`

- **Auth/authorization:** Required; owner/editor.
- **Body:** `{ "originalName", "mimeType", "size" }`; extension, MIME type, and 1 byte–15 MiB size are checked.
- **Success:** `201 { source: { _id, originalName, mimeType, size, status, uploadStatus }, uploadUrl }`. `uploadUrl` is a short-lived capability for the configured private Supabase bucket; keep it private.
- **Errors:** `400` invalid metadata; `403` insufficient role; `410` project deletion has started; `503` storage configuration unavailable; `502` safe storage-provider failure.

### `POST /api/sources/:sourceId/complete`

Finalize a previously authorized Supabase upload and extract text.

- **Auth:** Required; project member, with uploader/intent checks performed by the workflow.
- **Success:** `200 { source: { _id, originalName, status, uploadStatus, extractedCharacters }, alreadyCompleted }`.
- **Errors:** `400` invalid upload; `403` unauthorized source/uploader; `404` missing upload intent; `409` mismatched or incomplete object; `410` project deletion lifecycle; `503` storage configuration issue. Repeated completion is safe and idempotent.

### `GET /api/projects/:id/sources`

List sources for a project.

- **Auth:** Required.
- **Authorization:** Member.
- **Path:** `id` — project ObjectId.
- **Success:** `200` — `{ "sources": [...] }`, serialized Source documents with `extractedText` and `storagePath` excluded.
- **Errors:** `400` invalid project ID; `403` not a member; `404` project not found; otherwise global error response.

### `GET /api/sources/:sourceId/content`

Read extracted text for a processed source.

- **Auth:** Required.
- **Authorization:** Member of the source’s project.
- **Path:** `sourceId` — source ObjectId.
- **Success:** `200` — `{ "source": { "_id": "...", "originalName": "...", "mimeType": "...", "size": number, "extractedText": "..." } }`.
- **Errors:** `403` access denied; `404` source not found; `409` source processing has not completed; otherwise global error response.
- **Query:** GitHub sources may specify `revisionId=<SourceRevision ObjectId>` to retrieve the exact immutable snapshot; without it, current extracted text is returned. Invalid revision query is `400`; a revision not belonging to the source is `404`.

### `GET /api/sources/:sourceId/revisions`

List immutable GitHub source revisions and provenance metadata.

- **Auth:** Required; project member.
- **Query:** `page` defaults to 1; `limit` defaults to 20 and is capped at 50.
- **Success:** `200 { revisions, page, limit, total, hasMore }`. Each revision includes its key/hash, provider timestamps, locator, and `isCurrent`/`isAnalyzed` flags. For uploaded sources the response is an empty revision list.
- **Errors:** `400` invalid source ID or pagination; `403` no project access; `404` source missing; `410` project deletion lifecycle.

### `GET /api/sources/:sourceId/download`

Download the original uploaded file, or read the normalized text representation for a GitHub source.

- **Auth:** Required.
- **Authorization:** Member of the source’s project.
- **Path:** `sourceId` — source ObjectId.
- **Success:** Uploaded source returns a file attachment (or a short-lived Supabase redirect); GitHub source returns plain text with its source MIME type.
- **Errors:** `403` access denied; `404` source not found; `503` storage unavailable; `410` local file unavailable. File-system errors use the global handler if response headers have not been sent.

### `GET /api/sources/:sourceId`

Retrieve source metadata and extracted content.

- **Auth:** Required.
- **Authorization:** Member of the source’s project.
- **Path:** `sourceId` — source ObjectId.
- **Success:** `200` — `{ "source": { "_id", "project", "originalName", "mimeType", "size", "status", "extractedText", "uploadedBy", "createdAt", "updatedAt" } }`. Values follow the Source document.
- **Errors:** `403` access denied; `404` source not found; otherwise global error response.

### `DELETE /api/sources/:sourceId`

Delete a source and attempt to remove its local file.

- **Auth:** Required.
- **Authorization:** Editor.
- **Path:** `sourceId` — source ObjectId.
- **Body:** None consumed.
- **Success:** `200` — `{ "message": "Source deleted" }` for uploaded sources.
- **Errors:** `403` no project access or editor permission; `404` source not found; `409` for GitHub-imported sources, which are retained for revision/handover provenance; otherwise global error response.
- **Behavior:** GitHub sources cannot be directly deleted. Unlink the repository to stop future synchronization. Uploaded-source file cleanup follows the configured storage backend.

## AI analysis jobs and findings

### `POST /api/projects/:id/analyze`

Create or retrieve a persisted analysis job for selected processed sources.

- **Auth:** Required.
- **Authorization:** Editor.
- **Path:** `id` — project ObjectId.
- **Body:** Optional `{ "sourceIds": ["..."] }`; when omitted, eligible project sources are selected by the existing job service.
- **Success:** `202` for a newly queued job, `200` for an existing/started job, or `200 { "job": null, "alreadyAnalyzed": true, "message": ... }` when all eligible sources are already analyzed. The job is advanced explicitly through the routes below; this endpoint does not run the complete analysis synchronously.
- **Errors:** `400` invalid selection/no eligible sources; `403` caller cannot edit project; `404` project not found; `409` conflicting job/state; provider errors are surfaced when a source step is advanced, not during job creation.
- **Behavior:** GitHub sources are pinned to their current immutable revision when the job is created; retries keep that revision. Uploaded-source behavior and legacy jobs remain supported. Each source input is limited to 45,000 characters, and evidence verification uses the exact analyzed snapshot. GitHub sync never starts analysis automatically.

### `GET /api/projects/:id/analysis-job`

Read the project's persisted analysis job. **Auth:** Member. **Success:** `200 { job }` (job may be null). **Errors:** `403` non-member; `404` project not found.

### `GET /api/analysis-jobs/:jobId`

Read one analysis job. **Auth:** Project member allowed to read the job. **Success:** `200 { job }`. **Errors:** `400` invalid ID; `403` no access; `404` missing job; `410` project deletion lifecycle.

### `POST /api/analysis-jobs/:jobId/advance` and `POST /api/analysis-jobs/:jobId/retry`

Advance one source or explicitly retry a failed source. **Auth:** Owner/editor. **Success:** `200 { job }`. **Errors:** `400` invalid transition; `403` unauthorized; `404` job missing; `409` conflict; provider failures use safe status/error responses. Completed source checkpoints are retained across retries.

### `GET /api/projects/:id/findings`

List project findings.

- **Auth:** Required.
- **Authorization:** Member.
- **Path:** `id` — project ObjectId.
- **Success:** `200` — `{ "findings": [...] }`. Finding documents include evidence with source references populated with `originalName` where available.
- **Errors:** `400` invalid project ID; `403` not a member; `404` project not found; otherwise global error response.

## Review actions and history

Finding-level routes first validate the finding ID, load its project, and check membership. Read access requires a project member; changes require owner/editor. Review updates and history creation run through a MongoDB transaction.

### `PATCH /api/findings/:findingId`

Edit finding fields before approval.

- **Auth:** Required.
- **Authorization:** Editor.
- **Path:** `findingId` — finding ObjectId.
- **Body:** One or more of `title` (non-empty string, maximum 500 characters), `description` (non-empty string, maximum 5,000 characters), `category` (one of `Decision`, `Completed Work`, `Pending Tasks`, `Responsibilities`, `Blockers`, `Dependencies`, `Risks`, `Next Actions`, `Unresolved Questions`). Unknown fields are rejected. At least one value must change.
- **Success:** `200` — `{ "finding": <updated Finding document> }`.
- **Errors:** `400` invalid body/field/category; `403` non-member/viewer; `404` finding not found; `409` status does not permit editing; otherwise global error response.
- **Behavior:** Only pending or clarification-needed findings can be edited. Editing a clarification-needed finding returns it to pending. The action is recorded in review history. Evidence is not automatically verified by editing.

### `POST /api/findings/:findingId/approve`

Approve a pending finding.

- **Auth:** Required.
- **Authorization:** Editor.
- **Path:** `findingId` — finding ObjectId.
- **Body:** Empty JSON object `{}`; request body must be an object and no fields are accepted.
- **Success:** `200` — `{ "finding": <updated Finding document> }`.
- **Errors:** `400` invalid body or unexpected fields; `403` non-member/viewer; `404` finding not found; `409` finding is not pending; otherwise global error response.
- **Behavior:** Approval is a human review action and does not change evidence verification status.

### `POST /api/findings/:findingId/reject`

Reject a pending finding.

- **Auth:** Required.
- **Authorization:** Editor.
- **Path:** `findingId` — finding ObjectId.
- **Body:** `{ "reason": "..." }`; non-empty after trimming, maximum 2,000 characters.
- **Success:** `200` — `{ "finding": <updated Finding document> }`.
- **Errors:** `400` missing/blank/too-long reason or invalid body; `403` non-member/viewer; `404` finding not found; `409` finding is not pending; otherwise global error response.

### `POST /api/findings/:findingId/clarify`

Request clarification on a pending finding.

- **Auth:** Required.
- **Authorization:** Editor.
- **Path:** `findingId` — finding ObjectId.
- **Body:** `{ "comment": "..." }`; non-empty after trimming, maximum 2,000 characters.
- **Success:** `200` — `{ "finding": <updated Finding document> }`.
- **Errors:** `400` missing/blank/too-long comment or invalid body; `403` non-member/viewer; `404` finding not found; `409` finding is not pending; otherwise global error response.

### `POST /api/findings/:findingId/reopen`

Reopen an approved finding for correction.

- **Auth:** Required.
- **Authorization:** Editor.
- **Path:** `findingId` — finding ObjectId.
- **Body:** `{ "reason": "..." }`; non-empty after trimming, maximum 2,000 characters.
- **Success:** `200` — `{ "finding": <updated Finding document> }`; status becomes `pending`.
- **Errors:** `400` missing/blank/too-long reason or invalid body; `403` non-member/viewer; `404` finding not found; `409` finding is not approved; otherwise global error response.
- **Behavior:** Existing review history is retained and a `reopened` action is appended. The finding requires a new review decision.

### `GET /api/findings/:findingId/review-history`

Retrieve review history for a finding.

- **Auth:** Required.
- **Authorization:** Member of the finding’s project; viewers may read.
- **Path:** `findingId` — finding ObjectId.
- **Success:** `200` — `{ "history": [...] }`, oldest first. Each entry is a ReviewHistory document with `reviewer` populated with `name` and `email`.
- **Errors:** `400` invalid finding ID; `403` not a project member; `404` finding not found; otherwise global error response.

Review history actions stored by the implementation are `approved`, `rejected`, `clarification_requested`, `edited`, `returned_to_pending`, and `reopened`. History documents include finding/project/reviewer references and may include `previousValues`, `updatedValues`, `reason`, and `comment`; Mongoose timestamps provide creation/update times.

## Handover generation, history, and download

### `POST /api/projects/:id/handover`

Create the next saved handover version from currently approved findings.

- **Auth:** Required.
- **Authorization:** Editor.
- **Path:** `id` — project ObjectId.
- **Body:** No fields are consumed.
- **Success:** `201` — `{ "handover": <serialized Handover document> }`, including `version`, `reportContent`, `findingIds`, `createdBy`, and `approvalStatus: "pending"` when assigned signoff is enabled or `"draft"` otherwise.
- **Errors:** `400` invalid project ID; `403` not a project member/editor; `404` project not found; `409` another handover is being generated; otherwise global error response.
- **Behavior:** The immutable snapshot includes findings approved at generation time and only human-confirmed contradiction candidates, with evidence/rationale. A lock prevents concurrent version creation. The saved snapshot is not updated by later changes. In assigned mode, an approver other than the creator must sign the exact version; legacy mode leaves it as draft.

### `GET /api/projects/:id/handovers`

List saved handover versions for a project.

- **Auth:** Required.
- **Authorization:** Member.
- **Path:** `id` — project ObjectId.
- **Success:** `200` — `{ "handovers": [...] }`, newest version first. The route selects handover fields and populates `createdBy` with `name` and `email`.
- **Errors:** `400` invalid project ID; `403` not a project member; `404` project not found; otherwise global error response.

### `GET /api/handovers/:handoverId`

Retrieve one saved handover version.

- **Auth:** Required.
- **Authorization:** Member of the handover’s project.
- **Path:** `handoverId` — handover ObjectId.
- **Success:** `200` — `{ "handover": <selected Handover document> }`. Selected fields include project, version, report content, finding IDs, approval status, creator, and timestamps; creator is populated with `name` and `email`.
- **Errors:** `400` invalid handover ID; `403` no project access; `404` handover not found; otherwise global error response.

### `GET /api/handovers/:handoverId/download`

Download the PDF rendered from a saved handover snapshot.

- **Auth:** Required.
- **Authorization:** Member of the handover’s project.
- **Path:** `handoverId` — handover ObjectId.
- **Success:** `200` binary PDF with `Content-Type: application/pdf`, `Content-Disposition: attachment; filename="relay-handover-v<version>.pdf"`, `Content-Length`, and `Cache-Control: private, no-store`.
- **Errors:** `400` invalid handover ID; `403` no project access; `404` handover not found; PDF generation errors use the global error handler.
- **Behavior:** PDFKit renders the stored `reportContent`; it does not run Gemini or rebuild the snapshot from current findings.

## Health check

### `GET /api/health`

Check that the Express API process is responding.

- **Auth:** Not required.
- **Success:** `200` — `{ "status": "ok", "service": "RELAY API" }`.
- **Limit:** This is a process health response; it does not query MongoDB or Gemini.

## Response-shape notes

Where a route returns a Mongoose document directly, the exact serialized document can include standard Mongoose fields and depends on the model’s serialization. This reference names the route envelope and model fields established by the inspected schema; it does not promise a versioned wire schema beyond what current route code returns. The current implementation does not define pagination, filtering, or query parameters for these routes.
