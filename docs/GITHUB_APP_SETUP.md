# RELAY GitHub App Setup

This guide covers the implemented GitHub App authorization, repository linking, bounded README/commit/issue ingestion, immutable source revisions, and explicit revision-pinned analysis. Sync is manual and owner-initiated; there are no GitHub webhooks or scheduled sync jobs.

## GitHub App settings

Create a GitHub App with repository permissions limited to:

- **Contents: Read-only**
- **Issues: Read-only**

Do not subscribe to webhook events for this phase. Keep the App private key and OAuth client secret in the server deployment's secret configuration.

Set the GitHub App **Setup URL** to the deployed URL represented by `GITHUB_APP_SETUP_URL`, whose path must be `/api/integrations/github/setup`. Set the GitHub App's **User authorization callback URL** to the deployed URL represented by `GITHUB_APP_OAUTH_CALLBACK_URL`, whose path must be `/api/integrations/github/oauth/callback`. The OAuth callback URL must exactly match the callback URL registered in GitHub. Use HTTPS outside local development.

## Server configuration names

Configure these names in the server environment or deployment secret store; do not place credentials in frontend `VITE_*` settings:

- `GITHUB_APP_ID`
- `GITHUB_APP_SLUG`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_APP_CLIENT_ID`
- `GITHUB_APP_CLIENT_SECRET`
- `GITHUB_APP_SETUP_URL`
- `GITHUB_APP_OAUTH_CALLBACK_URL`

The setup URL is checked by the server and must match the URL configured in the GitHub App. The OAuth callback URL is sent in the OAuth authorization request and must match GitHub's registered callback. For multiline PEM keys supplied through a single-line secret field, the server accepts escaped newline sequences and converts them in memory.

Audit events also require the existing `AUDIT_RETENTION_DAYS` setting to be a positive whole number.

## Authorization flow

For an App already installed on the GitHub account, RELAY starts GitHub user authorization directly. It binds a one-time, hashed, ten-minute state to the initiating project and owner, uses the short-lived callback code to list that user's installations, and verifies each candidate against the RELAY GitHub App API before storing authorization. The temporary user token is revoked before authorization records are written. The callback then returns the browser to the same RELAY project.

If no active RELAY App installation is found, the owner can start installation using the App install URL. GitHub returns `installation_id`, `setup_action`, and the one-time setup state to the configured Setup URL. The current implementation accepts `install` and `update`, verifies the installation through the GitHub App API, then creates a separate one-time OAuth state. The OAuth callback verifies that the GitHub user can access that exact installation before persisting authorization. Other `setup_action` values are rejected until their callback behavior is explicitly supported.

After authorization, RELAY only lists the installations the owner authorized. The owner selects an installation, discovers repositories accessible to it, and explicitly links a repository to the project. Installation authorization never links a repository automatically. A GitHub App installation can be reused across projects only by a project owner who separately passes server-side user-to-installation verification for that project.

The routes are `POST /api/projects/:id/github/installations/authorize` for an existing installation and `POST /api/projects/:id/github/installations/start` when the App must first be installed. Both are owner-only. Repository discovery and linking remain separate owner-only actions.

Installation access tokens are minted in memory for individual GitHub API requests and are not persisted. Active status older than five minutes is returned as `unverified`; repository discovery and linking refresh installation status before use. Unlinking marks a repository link as unlinked rather than deleting it, preserving its identity for future source-revision provenance. Relinking creates a new link identity.

## Route summary

- `POST /api/projects/:id/github/installations/start`
- `POST /api/projects/:id/github/installations/authorize`
- `GET /api/integrations/github/setup`
- `GET /api/integrations/github/oauth/callback`
- `GET /api/projects/:id/github/installations`
- `GET /api/projects/:id/github/repositories` (active project links; project members may read)
- `GET /api/projects/:id/github/repositories?installationId=...` (owner-only GitHub repository discovery)
- `POST /api/projects/:id/github/repositories` (owner-only link)
- `DELETE /api/projects/:id/github/repositories/:linkId` (owner-only soft unlink)

No GitHub access token, private key, OAuth code, or callback state belongs in application logs, audit metadata, or browser storage. Audit repository metadata is limited to the GitHub repository ID and `owner/name`.

## Implemented ingestion behavior

The approved and implemented behavior is documented in [ROUND3_PHASE4_IMPLEMENTATION_PLAN.md](ROUND3_PHASE4_IMPLEMENTATION_PLAN.md). Only a current project owner can trigger a bounded synchronous sync of an actively linked repository. The approved maximum is 50 recent commits, the latest 100 updated issues across all states excluding pull requests, and the repository README. Issue comments and commit diffs are excluded. Limits are 2 MiB raw HTTP response bytes per response before JSON parsing, 8 MiB aggregate normalized content per sync, README 256 KiB; commit messages 8 KiB each/256 KiB aggregate; issue title/body 16 KiB each/1 MiB aggregate. Issue scanning is capped at five pages of 100 raw entries; the actual issue count is returned, and the result is marked partial if that cap prevents reaching 100.

The flow uses persisted job checkpoints, an atomic per-link active lock, a strict server-owned 45-second deadline, 10-second provider timeouts, expiring leases, and explicit owner retry. The checked-in `server/vercel.json` configures 300 seconds for the backend functions, but the deployed Vercel project root and effective dashboard/runtime cap must be confirmed before rollout; lower the app deadline if the live limit requires it. A disconnected browser will not cancel the server-owned work. GitHub sources and immutable revisions must retain the `SourceRevision → Source → ProjectRepository` provenance chain; unlinked repositories cannot be synced. Installation status refreshes when stale and repository access is verified during sync. Explicit analysis pins immutable revisions into existing per-source AI jobs before enabling GitHub sources for analysis, without changing upload analysis behavior, automatically starting AI after sync, or marking old findings stale.
