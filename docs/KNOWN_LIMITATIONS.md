# RELAY Known Limitations

This document separates behavior confirmed in the current code from possible future work. Items in the Round 3 section are suggestions only, not committed or implemented features.

## A. Current functional limitations

- **Campus Connect is illustrative demo data.** It is client-side sample content, not a database-backed workspace. It makes no API requests; its source files are not attached; source open/download is disabled; upload, Gemini analysis, review mutations, report generation, and PDF export are unavailable in demo mode. Sample findings and quotations must not be presented as live Gemini results or verified evidence.
- **Settings is mostly informational.** Profile editing, password recovery, notification delivery, review-requirement configuration, activity history, and project archive/ZIP export are unavailable. The Settings page’s environment panel is illustrative and is not a live view of server configuration.
- **Project controls are incomplete in the UI.** The project Edit and Archive controls are disabled, although project update and delete API routes exist. There is no archive lifecycle. The API’s project delete handler deletes only the Project document; it does not cascade deletion to sources, findings, review history, handovers, or local uploaded files, so deleting a project through the API can leave related records/files behind.
- **No report approval workflow exists.** Generated handovers are saved with `approvalStatus: draft`. There is no endpoint to approve or publish a report. Finding approval is implemented and remains separate from report approval.
- **Collaboration has no invitation delivery or ownership transfer.** Owners can add only an existing registered user by email. The app does not send invitation messages or transfer project ownership.
- **AI provider output is not guaranteed.** Gemini is primary; after bounded retries, Cloudflare Workers AI (`@cf/meta/llama-3.1-8b-instruct`) is tried once only for transient Gemini provider/network failures. Cloudflare results must pass strict structure and exact source-quote verification; if they do not, the source analysis fails without saving fallback findings. The service sends up to 45,000 characters per source and accepts a fixed set of finding categories. It does not guarantee a finding for every important detail or a repeatable result for the same input. Successfully analyzed sources are not analyzed again by an ordinary repeat request.
- **Evidence verification is exact-text matching, not semantic validation.** The verifier tolerates limited Markdown list-marker and whitespace differences, maps verified matches to offsets in extracted text, and keeps paraphrases or unsupported quotations unverified. It does not establish whether the surrounding finding description is a faithful interpretation of the source. It depends on extracted-text quality; no OCR pipeline is implemented for image-only/scanned documents.
- **Source deletion can leave an orphan file.** The delete route ignores local file-unlink errors and then removes the Source record.

## B. Testing and verification limitations

- There is no frontend automated test script or browser end-to-end suite in the client package. The client defines a Vite production build command, not a UI test command.
- Backend tests are primarily service-level tests for evidence verification, Gemini retry/error behavior, handover report logic, membership, and review workflow. They do not exercise every Express endpoint through a running server.
- The automated suite does not establish live MongoDB/Atlas connectivity, live Gemini provider availability, browser rendering, actual account registration in a deployed environment, or a real download through a browser. Those workflows require separate environment-specific verification.
- The server `check` script checks the `server.js` entry point only; it is not a full syntax check of every backend source file.
- `GET /api/health` reports that the Express process responds. It does not test MongoDB or Gemini connectivity.

## C. Deployment and infrastructure limitations

- **Uploaded files are local.** The backend writes to an `uploads` directory relative to its process working directory. Ephemeral filesystems, multiple backend instances, backup policy, access controls, and retention require deployment-specific handling. MongoDB stores extracted text and file metadata, while the original upload remains on disk.
- **API routing must be configured for production.** Vite proxies `/api` to local `127.0.0.1:5000` in development. Production requests default to `/api` unless `VITE_API_URL` is provided at build time or `window.RELAY_API_URL` is set at runtime. Hosting must route that API base to Express and configure server `CLIENT_URL` with the allowed frontend origin.
- **External CDN assets are runtime dependencies.** `client/index.html` loads Tailwind, Lucide icons, and Google Fonts from external CDNs. A restricted or offline network may prevent some styling, icons, or fonts from loading.
- **Transaction support is required for transactional flows.** Review updates/history and analysis persistence use MongoDB transactions. Use MongoDB Atlas or a transaction-capable replica set; a standalone MongoDB server may not support those operations.
- **Browser tokens use local storage.** JWT authentication lasts up to 12 hours; the client removes its token on logout, but the server does not maintain a revocable session record. The implementation does not use HttpOnly session cookies.
- **Rate limiting is process-local by default.** Express rate limiting is configured for 300 requests per 15 minutes using the middleware’s default store. A multi-instance deployment would need shared rate-limit storage for a coordinated limit.
- **Provider model availability is not guaranteed.** The server can be configured with `GEMINI_MODEL`; Cloudflare fallback currently uses the fixed model identifier `@cf/meta/llama-3.1-8b-instruct`. Account availability, permissions, quotas, latency, and output quality remain provider-controlled.
- **Runtime configuration must remain server-side.** MongoDB credentials, JWT signing secret, Gemini key, and Cloudflare account/token values must not be exposed through client build variables or browser UI. The Settings environment panel is not an authoritative configuration source.

## D. Potential Round 3 improvements

These are candidate areas for future planning, not current RELAY functionality:

- Add OCR or another explicit path for scanned/image-only documents and expose extraction quality.
- Use durable private object storage with retention, backup, and cleanup policies; add safe cascading deletion or an explicit archival lifecycle.
- Add email invitations and ownership transfer only with a defined authorization and audit design.
- Complete profile/password recovery, notifications, activity history, project edit/archive UI, project export, and report approval if those workflows are needed.
- Add API integration tests, browser end-to-end tests, and environment-gated MongoDB/Gemini verification with clear separation from mocked unit tests.
- Add production deployment guidance for TLS, shared rate limiting, observability, backup/restore, and environment-specific API routing.
- Consider source chunking or document-aware analysis for inputs beyond the current per-source prompt excerpt, while retaining evidence traceability.

For the current demo workflow, see the [Demo Guide](DEMO_GUIDE.md). For implementation details, see [Architecture](ARCHITECTURE.md) and the [API Reference](API_REFERENCE.md).
