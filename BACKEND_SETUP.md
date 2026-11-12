# RELAY Backend Setup

This guide covers the existing Express API setup and its connection to the Vite frontend. It describes local development; it is not a complete production deployment guide. For the product workflow and roles, see the [root README](README.md).

## Requirements

- Node.js and npm. The repository does not declare a required Node.js version.
- A reachable MongoDB database (local or Atlas).
- A Gemini API key to run document analysis.

The repository has separate `server` and `client` packages and no root package manifest.

## Configure environment

From the repository root, create the server environment file:

```powershell
cd server
Copy-Item .env.example .env
```

Set local values for the variable names below in `server/.env`. Do not commit that file or put credentials in documentation:

| Variable | Purpose |
| --- | --- |
| `PORT` | Express port; local default is `5000`. |
| `NODE_ENV` | Runtime environment. |
| `CLIENT_URL` | Allowed browser origin for CORS; use `http://localhost:5173` locally. A comma-separated list is supported. |
| `MONGODB_URI` | MongoDB connection URI. |
| `JWT_SECRET` | Secret used to sign authentication tokens. |
| `GEMINI_API_KEY` | Gemini API key, used only by the backend. |
| `GEMINI_MODEL` | Optional Gemini model identifier. Check provider availability for the account before configuring a specific model. |

The client also provides `client/.env.example` with `VITE_API_URL=/api`. The Vite development server proxies `/api` to `http://127.0.0.1:5000`, so the default works for local development without a separate API URL.

## Install and run the backend

From the repository root:

```powershell
cd server
npm install
npm run dev
```

The development server starts from `server/server.js`, loads `server/.env`, connects to MongoDB, and listens on `PORT` (default `5000`). The health endpoint is `http://localhost:5000/api/health`.

For a non-watch start, use `npm start` from `server`.

## Run the frontend

In a second terminal from the repository root:

```powershell
cd client
npm install
npm run dev
```

Open `http://localhost:5173`. In development, Vite forwards `/api` requests to `http://127.0.0.1:5000` as configured in `client/vite.config.js`.

For production, the frontend API base defaults to `/api`. Set `VITE_API_URL` at Vite build time, or `window.RELAY_API_URL` before the frontend application starts, if the API uses a different base URL. Ensure the deployed frontend origin is allowed by server `CLIENT_URL` and configure the hosting proxy or network so the selected API URL reaches Express. Keep `GEMINI_API_KEY`, `JWT_SECRET`, and `MONGODB_URI` on the server; do not expose them as `VITE_*` variables.

## Authentication and document flow

Users register or log in through the frontend. The backend issues a bearer token that the client stores in browser local storage and uses for authenticated API requests. The token expires after 12 hours; the client restores a session by checking the current user with the API. This is token-based authentication, not a server-side session cookie.

The real project workflow uses the MongoDB ID of the currently selected project:

1. An authenticated owner or editor uploads a PDF, DOCX, TXT, or MD file to that project using the `file` multipart form field.
2. The backend stores the original file under `server/uploads`, extracts text, and saves source metadata and extracted text in MongoDB.
3. An owner or editor requests analysis for that project. Gemini analyzes processed source text; analysis failures do not remove uploaded sources.
4. RELAY checks evidence quotes against stored extracted text. Human review status and quote verification status remain separate.

Uploads are limited to 15 MB per file. Only project members can read project sources; backend authorization also restricts mutation and review operations by role. Membership management is owner-only. No email service is required to add an existing RELAY user.

## Backend commands

Run from `server`:

```powershell
npm test
npm run check
```

`npm test` runs the Node test suite. `npm run check` checks the top-level `server.js` entry file syntax; it does not syntax-check every file in `server/src`. The tests cover backend service logic, including evidence verification, Gemini retry/error handling, handover report behavior, membership, and review workflows. They do not constitute browser tests or prove live MongoDB/Atlas or Gemini-provider integration.

The detailed API endpoint reference is intentionally deferred to a separate documentation phase. The health endpoint is `GET /api/health`.

## Troubleshooting

- **Database connection fails:** check the `MONGODB_URI`, database reachability, and Atlas network access configuration without sharing the URI.
- **Authentication fails:** confirm the server has `JWT_SECRET` configured and sign in again if the token has expired.
- **CORS blocks the browser:** make `CLIENT_URL` match the frontend origin, including scheme and port.
- **Upload is rejected:** check that the file is PDF, DOCX, TXT, or MD and no larger than 15 MB.
- **Gemini analysis fails:** check server-side API credentials, quota, provider availability, and whether the configured model identifier is available to the account. Retryable provider errors are surfaced as analysis errors; uploaded sources remain saved.
- **Frontend cannot reach the API:** confirm the backend is running on port `5000`, the Vite `/api` proxy is active, or the production API base/proxy is configured correctly.

Uploaded files are stored on local disk. Use durable private storage and define access, backup, and retention policies for deployments where local files may be ephemeral.
