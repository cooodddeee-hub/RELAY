# RELAY API Reference

This reference was checked against `server/src/app.js`, all route modules in `server/src/routes/`, authorization middleware, service validation, and Mongoose models. It documents the current implementation; it is not a promise of an independently deployed API contract.

## Base URL and common behavior

The local API base is `http://localhost:5000/api`. In local frontend development, Vite proxies `/api` to `http://127.0.0.1:5000`.

Unless specified otherwise, endpoints require:

```http
Authorization: Bearer <JWT>
```

JSON endpoints accept `Content-Type: application/json`. The Express JSON parser has a 2 MB limit. Uploads use `multipart/form-data`.

`GET /api/health` is the only route mounted without `requireAuth`. The API applies Helmet, configured CORS, and a global rate limit of 300 requests per 15 minutes. The global error handler returns `{ "message": "Internal server error" }` for errors with status 500 or higher; lower-status errors use `{ "message": "..." }` when the error has a message. Some route-specific responses below are returned directly.

Project role shorthand used below:

- **Member**: project owner, editor, or viewer.
- **Editor**: project owner or editor.
- **Owner**: project owner only.

No endpoint below defines query parameters. IDs in paths are MongoDB ObjectIds. Project, finding, source, and handover access is checked on the backend.

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

Delete a project document.

- **Auth:** Required.
- **Authorization:** Owner only.
- **Path:** `id` — project ObjectId.
- **Body:** None consumed.
- **Success:** `200` — `{ "message": "Project deleted" }`.
- **Errors:** `400` invalid ID; `403` non-owner; `404` not found; otherwise global error response.
- **Behavior:** The route calls `deleteOne()` on the Project document. It does not implement a cascade for related sources, findings, review history, uploaded files, or handovers.

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
- **Success:** `201` — `{ "source": { "_id": "...", "originalName": "...", "status": "processed", "extractedCharacters": number } }`.
- **Errors:** `400` when no file was chosen; `400` invalid project ID; `403` caller lacks project access or editor permission; `404` project not found. Multer, extraction, and database errors pass to the global error handler; an error without an explicit status is returned as `500`.
- **Behavior:** The original file is written to local disk. The Source record and extracted text are stored in MongoDB. On extraction failure, the source is marked `failed`; the upload route does not explicitly remove the file.

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

### `GET /api/sources/:sourceId/download`

Download the original uploaded file.

- **Auth:** Required.
- **Authorization:** Member of the source’s project.
- **Path:** `sourceId` — source ObjectId.
- **Success:** File attachment named using the original filename’s basename. Express sets file response headers; there is no JSON success envelope.
- **Errors:** `403` access denied; `404` source not found; file-system errors pass to the global error handler if response headers have not been sent.

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
- **Success:** `200` — `{ "message": "Source deleted" }`.
- **Errors:** `403` no project access or editor permission; `404` source not found; otherwise global error response.
- **Behavior:** File unlink errors are ignored before the Source record is deleted.

## Gemini analysis and findings

### `POST /api/projects/:id/analyze`

Analyze processed, not-yet-analyzed sources for a project.

- **Auth:** Required.
- **Authorization:** Editor.
- **Path:** `id` — project ObjectId.
- **Body:** No fields are consumed. The current frontend sends an empty JSON object.
- **Success:** `200` — `{ "findings": [...], "message": "AI findings created; human review is required" }`. If all processed sources were already analyzed, the response contains current project findings and a message stating that sources have already been analyzed.
- **Errors:** `400` invalid project ID or no processed sources; `403` not a project member/editor; `404` project not found; `409` analysis lock already held or expired; `429` provider rate limit; `502` unusable Gemini response; `503` provider unavailable/configuration failure; `504` provider timeout; other failures may return `500`.
- **Behavior:** A project-level lock prevents concurrent analysis. The service retries selected transient Gemini/network failures up to two times after the initial call, uses a 30-second provider timeout, and analyzes up to two sources concurrently. Each prompt includes at most 45,000 characters of source text. Analysis writes are deduplicated; uploaded sources are retained on failure. Error messages are sanitized. Retryable `429` and `503` responses include `Retry-After: 2`.

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
- **Success:** `201` — `{ "handover": <serialized Handover document> }`, including `version`, `reportContent`, `findingIds`, `createdBy`, and `approvalStatus: "draft"`.
- **Errors:** `400` invalid project ID; `403` not a project member/editor; `404` project not found; `409` another handover is being generated; otherwise global error response.
- **Behavior:** The snapshot includes only findings whose status is `approved` at generation time. A lock prevents concurrent version creation. The saved snapshot is not updated by later finding changes. No report approval endpoint is implemented.

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
