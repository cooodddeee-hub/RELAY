# RELAY on Vercel

This guide deploys RELAY as two Vercel projects connected to the same repository: a static Vite frontend and the Express API. It does not change local development. In the Vercel dashboard, set each project's **Root Directory** as shown below so Vercel installs from that folder's package manifest.

## Backend project

- Root Directory: `server`
- Framework Preset: Express (automatic detection from the default-exported Express app)
- Build Command: leave the framework default; no separate build is required
- Output Directory: leave unset
- Node.js version: 22.x
- Function duration: `server/vercel.json` sets the Express function maximum to 300 seconds

Vercel's Express integration serves the default-exported app from `server.js` as one function (the configuration also covers `src/app.js` if Vercel selects that supported entry). On Vercel, `server.js` exports the app without opening a local listener or eagerly connecting to MongoDB; readiness middleware initializes/reuses the connection for requests. Outside Vercel, `npm start` still connects to MongoDB and listens on port 5000 as before. `/api/health` exposes only service status.

Add these server-side environment variable names in the backend Vercel project. Values are entered in Vercel and are not part of the repository:

| Name | Use |
| --- | --- |
| `MONGODB_URI` | MongoDB Atlas connection string for the RELAY database |
| `JWT_SECRET` | Signing key for authentication tokens |
| `CLIENT_URL` | Exact deployed frontend origin; comma-separated origins are supported for explicitly allowed preview origins |
| `GEMINI_API_KEY` | Gemini primary provider credential |
| `GEMINI_MODEL` | Optional Gemini model override; if omitted, the service's code default is used |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare fallback account |
| `CLOUDFLARE_API_TOKEN` | Cloudflare Workers AI fallback credential |
| `SUPABASE_URL` | Supabase project URL used only by the backend storage client |
| `SUPABASE_SECRET_KEY` | Server-only key used for private bucket operations |
| `SUPABASE_STORAGE_BUCKET` | Private source-file bucket, currently `relay-files` |

`PORT` and `NODE_ENV` are provided by the platform; do not add `SUPABASE_SECRET_KEY` or any AI credential to the frontend project. Keep the MongoDB Atlas database name and access rules configured for the existing RELAY database. Ensure Atlas network access allows the Vercel runtime to connect.

## Frontend project

- Root Directory: `client`
- Framework Preset: Vite
- Install Command: `npm install`
- Build Command: `npm run build`
- Output Directory: `dist`

Add these frontend build-time variables:

| Name | Value/use |
| --- | --- |
| `VITE_API_URL` | Backend deployment origin followed by `/api`, for example `https://your-api-domain/api` |
| `VITE_SUPABASE_URL` | Same Supabase project URL as the backend |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable browser key; never use the backend secret key here |

The frontend uses `VITE_API_URL` for production requests. The local Vite proxy still sends `/api` to `http://127.0.0.1:5000` when running `npm run dev`.

## Browser and storage access

Set backend `CLIENT_URL` to the frontend's exact HTTPS origin. If testing a Vercel Preview deployment, explicitly allow that preview origin as well; do not use a wildcard CORS origin. The API uses bearer-token authentication, so no cross-site auth cookies or credentials mode are required.

Keep the Supabase bucket private. The backend creates authorized signed upload and download capabilities; the browser uploads directly with the publishable key and the signed upload URL. Confirm the project's Supabase Storage CORS settings permit the deployed frontend origin if the browser reports a cross-origin upload error.

The legacy local-disk upload route is disabled in production. New originals use Supabase Storage. Existing local-only originals may not be present on a serverless instance; their source records remain, and original-file download returns unavailable when the file is missing. Extracted text remains in MongoDB.

## Analysis duration

The browser advances a persisted job one source at a time and polls/reloads its saved state. The job service's per-source soft budget is 240 seconds, while this Express function is allowed up to Vercel Hobby's 300-second maximum. With the current 30-second provider timeout and two retries per provider, a fully exhausted Gemini-plus-Cloudflare path can spend approximately 183 seconds in provider requests and backoff, before database and extraction overhead. This is below the 240-second soft budget, but provider and platform timing still need preview verification. Existing provider timeouts and retry limits are unchanged. A provider call that approaches the budget is recorded as retryable before the checkpoint is committed. The browser must remain open between source steps and polls the saved status during a step; closing it stops further browser-driven advancement, and reopening the project resumes the job. This is not background processing.

Vercel Hobby cannot exceed the 300-second hard function maximum. If a source repeatedly reaches that ceiling, the safe result is a retryable/failed job rather than guaranteed completion; do not increase provider retries or timeouts to work around the platform cap.

## Deployment order

1. Create the backend Vercel project with Root Directory `server`; add the server environment variables for Preview and Production; deploy.
2. Open `https://<backend-domain>/api/health`. Expect only `status` and `service` in its JSON response. A 503 means the database is not ready; check the Vercel function logs and Atlas network/access configuration without sharing credentials.
3. Create the frontend Vercel project with Root Directory `client`; set `VITE_API_URL` to the backend origin plus `/api`, and add the two Supabase browser variables; deploy.
4. Update backend `CLIENT_URL` with the frontend deployment origin and redeploy the backend.
5. Verify registration/login, project access, a small Supabase upload, and one-source analysis using a disposable project. Check Vercel function logs for timeout responses and confirm the frontend reports persisted job stages.

For a Preview environment, set Preview variables separately in both projects. The frontend Preview URL must be allowed by backend `CLIENT_URL`; the frontend Preview `VITE_API_URL` must point to the backend Preview deployment.
