# RELAY

> **When someone leaves, their knowledge doesn't.**

RELAY helps teams turn project documents into reviewed, evidence-linked knowledge that can be handed over when a teammate leaves. Decisions, responsibilities, risks, and open questions are captured in one project workspace, reviewed by people with the right access, and saved as versioned handover reports.

## How it works

1. A user creates a project and uploads its source documents.
2. RELAY extracts text and asks Cloudflare Workers AI (primary) or Gemini (fallback for supported temporary failures) to propose findings with source quotations.
3. RELAY checks each quotation against the extracted source text. Exact matches are marked verified; unsupported quotations remain unverified.
4. Project owners and editors review findings, correct them, approve or reject them, request clarification, or reopen an approved finding for correction.
5. An owner or editor generates a handover snapshot from currently approved findings and human-confirmed contradictions. The immutable snapshot is saved as a version. In assigned signoff mode, an assigned approver other than its creator approves or rejects that exact version before it can be treated as signed off.

## Implemented features

- Account registration, login, logout, and session restoration.
- Projects with owner, editor, and viewer access; owners can add existing RELAY users by email.
- Authenticated document upload, text extraction, source viewing, and download.
- Explicit Cloudflare Workers AI primary and Gemini secondary analysis, with revision-pinned GitHub analysis and retry handling for temporary provider failures.
- Finding evidence verification against original extracted text, including exact matched text and source offsets where verified.
- Persisted review actions and history, including approval, rejection, clarification, editing, and reopening.
- GitHub App repository linking and bounded manual README, commit, and issue ingestion with immutable source revision provenance.
- Human-reviewed cross-source contradiction candidates; only confirmed conflicts enter newly generated handovers.
- Reviewer/approver assignments, immutable handover version signoff, and project deletion/recovery.
- Immutable, versioned handover snapshots containing approved findings and confirmed contradiction summaries, with preview, PDF download, and exact-version approval/rejection history. New assigned-workflow projects require one assigned approver decision per version; rejections require a reason, creators cannot approve their own version, and decisions never carry forward to a newer version.
- A clearly labeled Campus Connect sample workspace for exploring the interface.

## Technology and architecture

| Layer | Implementation |
| --- | --- |
| Frontend | HTML, vanilla JavaScript, CSS, and Vite |
| Backend | Node.js and Express |
| Database | MongoDB through Mongoose |
| AI | Cloudflare Workers AI primary; Google Gemini secondary through `@google/genai` |
| PDF | PDFKit |

The browser application calls the Express API under `/api`. During local development, Vite proxies `/api` to `http://127.0.0.1:5001`; the backend defaults to port `5001` and honors an explicit `PORT`. The API verifies bearer-token authentication and project membership before serving project data or accepting edits. Uploaded originals use the configured private storage backend; extracted text and project workflow records are stored in MongoDB.

## Prerequisites

- Node.js and npm installed. The repository does not declare or enforce a Node.js version requirement.
- A MongoDB local instance or MongoDB Atlas database and a connection URI.
- Cloudflare Workers AI credentials and a Gemini API key for fallback analysis.

There is no root `package.json`; install and run the client and server separately.

## Local setup

### 1. Configure and start the backend

From the repository root, open a terminal and run:

```powershell
cd server
Copy-Item .env.example .env
```

Set the following variables in `server/.env` using your own local values. Keep real credentials out of source control.

| Variable | Purpose |
| --- | --- |
| `PORT` | Express listen port (defaults to `5001`). |
| `NODE_ENV` | Runtime environment. |
| `CLIENT_URL` | Allowed frontend origin; local Vite uses `http://localhost:5173`. Multiple allowed origins may be comma-separated. |
| `MONGODB_URI` | MongoDB connection string. |
| `JWT_SECRET` | Private signing secret for authentication tokens. |
| `GEMINI_API_KEY` | Server-side Gemini credential. |
| `GEMINI_MODEL` | Optional Gemini model identifier. Confirm its availability with your provider before setting it; RELAY does not guarantee availability of a particular model name. |
| `CLOUDFLARE_ACCOUNT_ID` | Server-side Cloudflare account ID used by Workers AI analysis. |
| `CLOUDFLARE_API_TOKEN` | Server-side token with Workers AI permission. |

Then install and start the API in the same terminal:

```powershell
npm install
npm run dev
```

The API listens on port `5001` by default. Check `http://localhost:5001/api/health` for its health response.

### 2. Start the frontend

Open a second terminal at the repository root:

```powershell
cd client
npm install
npm run dev
```

Open `http://localhost:5173`. The Vite development proxy forwards `/api` requests to the local backend.

For a production build, run `npm run build` from `client`. The frontend defaults to `/api`; configure `VITE_API_URL` at build time or `window.RELAY_API_URL` at runtime when the API is served from a different base URL. Configure the production server or proxy to route that URL to the Express API, and set `CLIENT_URL` to the deployed frontend origin.

## First real-workspace walkthrough

1. Use the registration screen to create an account, then sign in.
2. Create a project and select it from the project list.
3. Upload one or more supported documents (up to 15 MB each).
4. Run analysis. Owners and editors can analyze; viewers cannot.
5. Inspect findings and evidence. An `UNVERIFIED` label means RELAY could not establish an exact source match.
6. Review findings and their history. Approving a finding is a human decision; it does not verify its evidence quotation.
7. Generate a handover report from approved findings, select a saved version, preview it, and download its PDF.

## Project roles

| Role | Access |
| --- | --- |
| Owner | Full project access, including managing members and reviewing findings. |
| Editor | Read project data, upload sources, run analysis, and edit or review findings. Cannot manage membership or transfer ownership. |
| Viewer | Read project information, sources, findings, evidence, and review history. Cannot upload, edit, analyze, or perform review actions. |

Only the project owner can add existing registered RELAY users, change their Editor/Viewer role, or remove them. Inviting a user does not send email.

## Sources, Gemini, and evidence

RELAY accepts **PDF, DOCX, TXT, and MD** files, with a **15 MB per-file limit**. PDF and DOCX text is extracted server-side; TXT and Markdown are read as text. Original uploaded files are stored locally under `server/uploads`.

Cloudflare Workers AI (`@cf/openai/gpt-oss-20b`) is the primary provider for findings analysis. It retries recognized temporary failures with bounded backoff. After those retries are exhausted, RELAY invokes Gemini only for temporary HTTP 408, 429, 500, 502, 503, or 504 failures, recognized network failures, or timeouts. Authentication, permission, input, and malformed-response errors do not trigger provider fallback. Configure both providers on the server; Cloudflare credentials are never sent to the browser.

Both providers propose findings from extracted source text. The application checks Gemini quotes against the original text; Cloudflare findings are accepted only when every quote passes exact evidence verification. Harmless bullet and whitespace formatting differences are allowed. The original quote is retained; paraphrases, missing text, and unsupported Cloudflare quotes are rejected. Older findings without verification metadata are not assumed verified. Provider diagnostics record provider, request phase, duration, and fallback state without logging prompts or document text. Provider attempt metadata records provider, primary/secondary role, outcome, and safe status/category details.

Human review and evidence verification are separate: a finding can be approved by a reviewer while its quotation remains unverified. Review history records the reviewer action and applicable reason or comment.

## Review lifecycle

- **Pending:** awaiting a reviewer decision.
- **Approved:** accepted by a project owner or editor; eligible for inclusion in a newly generated handover snapshot.
- **Rejected:** rejected with a recorded reason.
- **Needs clarification:** returned with a required reviewer comment. An editor or owner can update it; the update returns it to pending.
- **Reopened:** an approved finding can be reopened with a required reason. It returns to pending and must be reviewed again.

Previous review history is retained. Reopening or editing does not change previously generated handover snapshots.

## Handover reports

An owner or editor can generate a report snapshot from findings approved at that time and confirmed contradiction candidates. Each generation is saved as an immutable version with preview and authenticated PDF download. In assigned signoff mode, the version starts pending and requires one decision from an assigned approver other than its creator; a rejection requires a reason. A pending older version is computed as superseded after a newer version is generated and cannot receive a new decision. Legacy projects with signoff disabled retain draft handovers.

## Demo workspace

The Campus Connect workspace contains fictional **DEMO DATA** so the product can be explored before uploading documents. Its sample findings are not Gemini output. Demo actions are labeled and do not persist to a real project or send documents to Gemini. Use the real sign-in workspace to create and manage persistent project data.

## Tests and checks

Run backend tests from the repository root:

```powershell
npm test --prefix server
```

The backend suite covers service-level evidence verification, Gemini retry/error behavior, handover report logic, membership rules, and review workflow logic. It is not a browser test suite and does not establish live MongoDB/Atlas integration or a successful live Gemini request. The server `check` script checks `server.js` syntax; it is not a complete syntax scan of every source file. The frontend has a production build, but no frontend test script is currently defined:

```powershell
npm run build --prefix client
```

## Known limitations and deployment notes

- Uploaded files use local disk storage. A deployment with ephemeral or multiple server instances needs durable private file storage and appropriate retention/access controls.
- Gemini availability, quotas, latency, and supported model identifiers depend on the configured provider account. Temporary provider failures can interrupt analysis; they do not mean the source upload failed.
- The demo workspace is illustrative and does not demonstrate persisted AI analysis.
- Settings features such as profile editing, password recovery, notifications, project archive export, and a general audit timeline are not implemented. Version-specific handover signoff and project deletion/recovery are implemented.
- The UI loads some styling, icon, and font assets from external CDNs; those assets require network access.
- This is a hackathon MVP, not a production-hardened service. Review deployment security, backups, logging, storage, and operational monitoring before production use.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [API Reference](docs/API_REFERENCE.md)
- [Vercel Deployment](VERCEL_DEPLOYMENT.md)
- [Production Database Migration Runbook](docs/DATABASE_MIGRATION_RUNBOOK.md)
- [Hackathon Demo Guide](docs/DEMO_GUIDE.md)
- [Known Limitations](docs/KNOWN_LIMITATIONS.md)
- [Backend Setup](BACKEND_SETUP.md)
- [Server utility notes](server/src/utils/README.md)
