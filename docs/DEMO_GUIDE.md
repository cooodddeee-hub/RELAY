# RELAY Hackathon Demo Guide

> **When someone leaves, their knowledge doesn't.**

## What to demonstrate

RELAY helps a team convert project documents into candidate findings, verify quotations against extracted source text, review findings as a team, and save versioned handover reports. Gemini proposes findings; an authorized person makes the review decision. A human approval does not turn an unverified quotation into verified evidence.

This guide has two distinct paths:

- **Sample workspace:** explore the interface without an account, MongoDB, or Gemini. Its Campus Connect content is fictional client-side demo data.
- **Real workflow:** register/sign in, store data in MongoDB, upload a fictional document, call Gemini, review findings, and generate a real PDF. This requires working MongoDB and Gemini configuration.

## Before the demo

For a real-workspace walkthrough, prepare:

- Node.js and npm, with dependencies installed in `server` and `client`.
- A reachable MongoDB database configured on the server. Atlas or a transaction-capable replica set is needed for workflows that use MongoDB transactions, including review history.
- A Gemini API key in the server environment and a model identifier available to that Gemini account. Provider availability, quota, and latency are not guaranteed by RELAY.
- A fictional, non-sensitive sample document. Do not upload private company, student, customer, or personal information.
- Optional: a second registered account if you want to demonstrate collaboration and Viewer permissions.

The UI-only Campus Connect sample needs the frontend running but does not need MongoDB or Gemini. The real account/project workflow requires MongoDB. Only real document analysis requires a functioning Gemini key and provider model. Health returning `ok` confirms the Express process responds; it does not confirm MongoDB or Gemini connectivity.

## Start the application

In PowerShell, from the repository root, start the backend in Terminal 1:

```powershell
cd server
Copy-Item .env.example .env -NoClobber
```

Set private local values in `server/.env` for `MONGODB_URI`, `JWT_SECRET`, `CLIENT_URL`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and the Supabase storage settings. `PORT` defaults to `5001`; local `CLIENT_URL` is `http://localhost:5173`. Cloudflare Workers AI is primary and Gemini (`GEMINI_API_KEY`, optional `GEMINI_MODEL`) is secondary. GitHub workflows additionally require the seven `GITHUB_APP_*` variables listed in [GitHub App Setup](GITHUB_APP_SETUP.md). Do not share terminal output or environment files containing credentials.

Then, still in Terminal 1:

```powershell
npm install
npm run dev
```

In Terminal 2, from the repository root:

```powershell
cd client
npm install
npm run dev
```

Open `http://localhost:5173`. The development server proxies `/api` requests to `http://127.0.0.1:5001`. The backend health URL is `http://localhost:5001/api/health`.

If dependencies are already installed, skip `npm install`. For the complete setup and production API URL configuration, see [Backend Setup](../BACKEND_SETUP.md).

## Explore the Campus Connect sample

1. On the sign-in screen, click **Explore Campus Connect Demo**.
2. Point out the persistent `DEMO DATA` banner and fictional Campus Connect project, sample sources, and sample findings.
3. Open findings and the evidence modal to show the sample quote and its verification label.
4. Explain that these records are hard-coded sample content: no API request is sent, sample quotes are not the results of a live Gemini call, original sample source files are not attached, and the source open/download controls are disabled.
5. Show the Review and Handover views as interface previews. Review mutation, upload, analysis, report generation, and PDF export are unavailable in sample mode. Demo project creation, where used, remains in the current browser session and is not saved to the real workspace.
6. Click **Exit demo · Sign in** to return to authentication and enter the real workspace.

Do not present sample quotations as verified source evidence or sample findings as live AI output.

## Run a real project walkthrough

### Register or sign in

From the sign-in screen, choose **Create account** to register, or sign in to an existing account. Successful authentication opens the real application and restores the account through the API on later page loads. Sessions use a bearer token stored in browser local storage and expire after 12 hours.

### Create a project and upload a fictional source

1. Open **Projects**, choose **New Project**, and enter a fictional project name such as `Campus Shuttle Tracker`.
2. Select the new project. Its MongoDB ObjectId is used by subsequent requests.
3. In **Sources**, upload a `.md`, `.txt`, `.docx`, or `.pdf` document no larger than 15 MB. For a concise demo, use a short fictional Markdown file such as:

```markdown
# Campus Shuttle Tracker — Fictional Project Notes

- Decision: Dispatcher sign-in will use the university identity provider.
- Completed: The team tested the route dashboard with two campus shuttle routes.
- Pending task: Add an alert when a shuttle is more than ten minutes late.
- Responsibility: Priya maintains the route configuration and weekly timetable.
- Risk: The pilot depends on continued access to the campus location feed.
```

This example is test input, not an assertion about an actual campus system. Gemini output varies; RELAY does not guarantee that a particular document produces a particular finding or exact quotation. The application analyzes source text once after successful processing; later analysis requests do not create duplicate findings for already analyzed sources. Upload a new fictional source if you need additional analysis input.

### Run Gemini analysis

Choose **Analyze New Sources** or **Re-analyze with Gemini**. This real action requires the configured server-side Gemini key, an available model, and a working MongoDB connection. The API analyzes processed sources that have not already been analyzed and creates pending findings. Temporary provider errors, quota limits, timeouts, or unusable model responses can prevent findings from being created; retrying does not delete the uploaded source.

If no pending findings are returned, describe that as the actual result. Do not substitute Campus Connect sample findings or claim the AI succeeded when it did not.

### Inspect findings and evidence

1. Open **AI Findings** or **Review & Approval**.
2. Choose **View evidence** to see the original model quote, verification status, source filename, matched passage when exact verification succeeded, and source context when available.
3. `VERIFIED · EXACT MATCH` means the verifier matched the quotation to the stored extracted source text, allowing limited Markdown bullet and whitespace formatting normalization.
4. `UNVERIFIED` means an exact match was not established. The original quote remains visible; RELAY does not treat a paraphrase as verified.
5. Use **Open original source** or **Download original** for a real uploaded source when available. These actions require project membership. In the Campus Connect sample they are disabled because no original source files are attached.

Human approval and automated evidence verification are separate. A finding can be approved while its quote remains unverified; call that out accurately during the demo.

### Demonstrate review actions

As the project owner or an editor:

1. **Approve** a pending finding. The UI asks for confirmation and records the reviewer action.
2. **Reject** a different pending finding. Confirm the action and provide a non-empty reason.
3. **Request clarification** on another pending finding with a required reviewer comment. Edit the clarification-needed finding; saving returns it to pending review.
4. Open the review history to show reviewer identity, timestamp, action, and applicable comments or changed fields.
5. Reopen an approved finding with a required reason. It returns to pending and requires review again.

These actions persist through the authenticated review API and MongoDB transaction. Do not attempt to reject or clarify a finding that is no longer pending; the backend rejects invalid transitions.

### Demonstrate Owner, Editor, and Viewer

The owner can add only an already registered RELAY account. There is no email invitation delivery.

1. Register a second account in a separate browser profile/private window, then sign it out.
2. Return to the project as its owner and open the project **Team** tab.
3. Add the second account by its registered email as **Editor** or **Viewer**.
4. Sign in as that account in the other browser profile and select the shared project.
5. As an Editor, show that project data is readable and that source upload, analysis, and finding review are permitted. Editors cannot manage membership.
6. As a Viewer, show read access to project sources, findings, evidence, history, and reports. Upload, analysis, review, and membership changes are not allowed.
7. Change the member’s role from the owner’s Team view to demonstrate the permission difference. The backend enforces the role; frontend visibility is not the only control.

### Demonstrate GitHub, contradictions, signoff, and recovery

1. As the project owner, authorize the configured GitHub App, discover an installation, discover repositories, and explicitly link one. Run **Sync GitHub** manually; sync does not automatically start AI analysis.
2. Select imported GitHub sources in the existing explicit analysis action. Show that evidence is tied to its immutable source revision.
3. In project review, detect contradiction candidates. They remain suspected until a permitted human reviewer confirms or dismisses with rationale. Only confirmed conflicts are included in subsequently generated handovers.
4. For a new assigned-workflow project, assign a reviewer/approver. Generate a handover as an eligible editor, then sign in as the assigned approver (not its creator) to approve or reject that exact version. Rejection requires a reason; a new version needs its own decision.
5. In owner settings, request project deletion and show the recovery deadline. Recover within the 30-day window before cleanup starts. Do not use a production project for this demonstration.

For a shorter presentation, explain the role matrix without creating a second account. Do not claim an unperformed role test.

### Generate and download a handover

1. Ensure at least one finding is approved. Rejected, pending, and clarification-needed findings are not included in new snapshots.
2. As owner or editor, open **Handover Reports** and choose **Generate New Version**.
3. Select the saved version in the version history and show its report preview.
4. Choose **Download PDF**. The authenticated API renders a PDF from the saved snapshot. The browser checks for `application/pdf` and a PDF file signature before starting the download.
5. Explain that later finding edits or reviews do not rewrite the generated version. A new generation creates the next version. In assigned workflow, signoff decisions are recorded against the exact handover version; the creator cannot approve their own version and rejection requires a reason.

PDF download requires a real saved handover and a project membership. There is no report generation or PDF export in sample mode.

## Suggested 5–7 minute presentation

| Time | Demonstration |
| --- | --- |
| 0:00–0:40 | State the knowledge handover problem and RELAY’s workflow. |
| 0:40–1:20 | Show the Campus Connect sample and clearly label its data as fictional demo content. |
| 1:20–2:00 | Switch to a real account and show a selected project and its membership role. |
| 2:00–3:00 | Upload a short fictional document and run Gemini analysis. State whether it succeeded and show the returned findings. |
| 3:00–4:00 | Open evidence; explain exact verification versus unverified quotation. |
| 4:00–5:00 | Approve one finding, clarify or reject another, and show review history. Reopen an approved finding if time permits. |
| 5:00–6:20 | Generate a handover, select the version, preview it, and download the PDF. |
| 6:20–7:00 | Summarize access control and the difference between sample data, AI suggestions, human approval, and saved report versions. |

If Gemini is unavailable, do not imply live analysis succeeded. Show the clearly labeled sample workspace, explain the provider outage, and demonstrate only any real persisted workflow that is already available. Do not pass sample content off as a real analysis result.

## Troubleshooting

- **Frontend cannot reach the API:** confirm the backend is running and the Vite server uses the `/api` proxy. Check that `CLIENT_URL` matches `http://localhost:5173`.
- **MongoDB operations fail:** confirm `MONGODB_URI` is configured and reachable. Review actions and analysis persistence use transactions; use Atlas or a transaction-capable replica set.
- **Health says `ok` but the workspace fails:** health checks only the Express process, not MongoDB or Gemini.
- **Registration or sign-in fails:** check the displayed validation message, API availability, and the server’s configured `JWT_SECRET`; do not paste credentials into screenshots or chat.
- **Upload fails:** use PDF, DOCX, TXT, or MD and keep each file at or below 15 MB.
- **Gemini analysis fails or takes too long:** check server-side key configuration, provider quota/availability, and model availability. The source should remain saved; use the actual error message and server logs to explain the result.
- **No report appears:** select the correct real project and ensure at least one finding is approved before generating a new snapshot.
- **Viewer cannot edit or the owner cannot add a member:** confirm the account’s role in the Team tab. Only an owner can manage membership; the added account must already exist.

See [Known Limitations](KNOWN_LIMITATIONS.md), the [API Reference](API_REFERENCE.md), and [Architecture](ARCHITECTURE.md) for implementation boundaries.
