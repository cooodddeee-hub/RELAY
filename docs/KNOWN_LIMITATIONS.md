# RELAY Known Limitations

This document lists remaining limitations in the current implementation. Round 3 GitHub ingestion, contradiction review, handover signoff, and project deletion/recovery are implemented; deployment-specific gates remain.

## A. Current functional limitations

- **Campus Connect is illustrative demo data.** It is client-side sample content, not a database-backed workspace. It makes no API requests; its source files are not attached; source open/download is disabled; upload, Gemini analysis, review mutations, report generation, and PDF export are unavailable in demo mode. Sample findings and quotations must not be presented as live Gemini results or verified evidence.
- **Settings is mostly informational.** Profile editing, password recovery, notification delivery, review-requirement configuration, activity history, and project archive/ZIP export are unavailable. The Settings page’s environment panel is illustrative and is not a live view of server configuration.
- **Project lifecycle UI is intentionally limited.** Owners can request tombstone deletion and recover within the recovery window; there is no general archive lifecycle or project export.
- **Signoff depends on assigned workflow policy.** Signoff is tied to exact handover versions, creator self-approval is denied, and rejection requires a reason. Existing projects retain legacy behavior until configured/opted in.
- **Collaboration has no invitation delivery or ownership transfer.** Owners can add only an existing registered user by email. The app does not send invitation messages or transfer project ownership.
- **AI provider output is not guaranteed.** Cloudflare Workers AI (`@cf/openai/gpt-oss-20b`) is primary. Gemini is secondary for supported provider failures; strict structure and exact source-quote verification remain required. The service sends up to 45,000 characters per source and accepts a fixed set of finding categories. It does not guarantee a finding for every important detail or a repeatable result for the same input. Successfully analyzed sources are not analyzed again by an ordinary repeat request. GitHub sync deliberately does not launch analysis; users must explicitly start it.
- **Evidence verification is exact-text matching, not semantic validation.** The verifier tolerates limited Markdown list-marker and whitespace differences, maps verified matches to offsets in extracted text, and keeps paraphrases or unsupported quotations unverified. It does not establish whether the surrounding finding description is a faithful interpretation of the source. It depends on extracted-text quality; no OCR pipeline is implemented for image-only/scanned documents.
- **Contradiction intelligence is deliberately narrow.** The detector proposes evidence-backed candidates only for the supported claim patterns and distinct source revisions implemented in `server/src/services/contradictions.js`. It is not general semantic contradiction detection, does not understand every domain-specific implication, and may miss conflicts or flag candidates that a reviewer dismisses. AI/detection output never confirms a conflict; only a human reviewer decision can include one in a new handover.
- **Storage recovery depends on deployment configuration.** Project deletion uses retryable cleanup, but uploaded originals still require deployment-specific backup and recovery planning.

## B. Testing and verification limitations

- Frontend tests cover workflow helpers and selected rendering behavior, but there is no full browser end-to-end suite validating real DOM/accessibility behavior.
- Backend tests are primarily service-level tests for evidence verification, Gemini retry/error behavior, handover report logic, membership, and review workflow. They do not exercise every Express endpoint through a running server.
- The automated suite does not establish live MongoDB/Atlas connectivity, live Gemini provider availability, browser rendering, actual account registration in a deployed environment, or a real download through a browser. Those workflows require separate environment-specific verification.
- The server `check` script checks the `server.js` entry point only; it is not a full syntax check of every backend source file.
- `GET /api/health` reports that the Express process responds. It does not test MongoDB or Gemini connectivity.

## C. Deployment and infrastructure limitations

- **Production browser verification remains required.** Mocked tests do not establish live GitHub App callbacks, provider availability, Vercel cron registration, storage permissions, or end-to-end browser accessibility.
- **API routing must be configured for production.** Vite proxies `/api` to local `127.0.0.1:5001` in development. Production requests default to `/api` unless `VITE_API_URL` is provided at build time or `window.RELAY_API_URL` is set at runtime. Hosting must route that API base to Express and configure server `CLIENT_URL` with the allowed frontend origin.
- **External CDN assets are runtime dependencies.** `client/index.html` loads Tailwind, Lucide icons, and Google Fonts from external CDNs. A restricted or offline network may prevent some styling, icons, or fonts from loading.
- **Transaction support is required for transactional flows.** Review updates/history and analysis persistence use MongoDB transactions. Use MongoDB Atlas or a transaction-capable replica set; a standalone MongoDB server may not support those operations.
- **Browser tokens use local storage.** JWT authentication lasts up to 12 hours; the client removes its token on logout, but the server does not maintain a revocable session record. The implementation does not use HttpOnly session cookies.
- **Rate limiting is process-local by default.** Express applies 300 requests per 15 minutes globally, with additional login limits of 10 per 15 minutes and registration limits of 5 per hour per IP. The default store is in-memory; multi-instance production needs shared storage for coordinated limits.
- **Provider model availability is not guaranteed.** The server can be configured with `GEMINI_MODEL`; Cloudflare uses the fixed model identifier `@cf/openai/gpt-oss-20b`. Account availability, permissions, quotas, latency, and output quality remain provider-controlled.
- **Runtime configuration must remain server-side.** MongoDB credentials, JWT signing secret, Gemini key, and Cloudflare account/token values must not be exposed through client build variables or browser UI. The Settings environment panel is not an authoritative configuration source.

## D. Potential Round 3 improvements

These are candidate areas for future planning, not current RELAY functionality:

- Add OCR or another explicit path for scanned/image-only documents and expose extraction quality.
- Use durable private object storage with a verified backup and recovery policy.
- Add email invitations and ownership transfer only with a defined authorization and audit design.
- Complete profile/password recovery, notifications, a general activity timeline, and project archive/export if those workflows are needed.
- Add API integration tests, browser end-to-end tests, and environment-gated MongoDB/Gemini verification with clear separation from mocked unit tests.
- Add production deployment guidance for TLS, shared rate limiting, observability, backup/restore, and environment-specific API routing.
- Consider source chunking or document-aware analysis for inputs beyond the current per-source prompt excerpt, while retaining evidence traceability.

For the current demo workflow, see the [Demo Guide](DEMO_GUIDE.md). For implementation details, see [Architecture](ARCHITECTURE.md) and the [API Reference](API_REFERENCE.md).
