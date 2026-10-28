# LINKSERVE POSTER MANAGEMENT SYSTEM

A React + Vite web app with an Express API for promotional poster management, Google Drive import, scheduling, and publishing history. The dashboard runs in a sample-data mode before external services are configured.

## Run locally

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env` and set the integrations you want to use.
3. Run `npm install`, then `npm run dev`.
4. Open the local Vite address shown in the terminal (the API runs on port 3001).

`APP_NAME` controls the displayed application name. In sample mode the app uses in-memory data, which resets when the API server restarts. Configure Supabase for persistent records and sign-in.

## Deploy on Render

The included [`render.yaml`](render.yaml) configures a single Node web service. It builds the Vite frontend and serves it from Express alongside the `/api` endpoints.

1. Push this project to a GitHub repository. Keep `.env` and `.google-drive-token.json` out of Git; both are ignored by `.gitignore`.
2. In Render, choose **New > Blueprint**, connect the repository, and deploy the `render.yaml` blueprint. You can also create a **Web Service** manually with build command `npm ci && npm run build` and start command `npm start`.
3. In the Render service's **Environment** settings, add the Supabase variables from `.env.example` (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`). Run `supabase/schema.sql` in the Supabase SQL editor and create user accounts in Supabase Auth.
4. Add any optional Google Drive or Viber variables in Render's Environment settings. For Google OAuth, set `GOOGLE_OAUTH_REDIRECT_URI` to `https://YOUR-SERVICE.onrender.com/api/drive/oauth/callback`, add the same URL as an authorized redirect URI in Google Cloud, and set `APP_ORIGIN` to `https://YOUR-SERVICE.onrender.com`.
5. Save the environment variables and redeploy. Open `https://YOUR-SERVICE.onrender.com/api/health`; a healthy response includes `ok: true`. Then open the service's root URL to use the app.

Render's free **Web Services** sleep after 15 minutes without inbound traffic. The next visit wakes the service, which can take about a minute. Free services also have an ephemeral filesystem, so the Google Drive token file will be lost when the service restarts or sleeps; reconnecting Drive may be required. The in-process scheduler also cannot run while the service is asleep. Render's free **Static Sites** stay available, but this app needs its Express API and scheduler, so hosting only the frontend as a static site is not a complete deployment.

## Supabase

Run [`supabase/schema.sql`](supabase/schema.sql) in the Supabase SQL editor. Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `VITE_SUPABASE_URL`, and `VITE_SUPABASE_ANON_KEY`. Create team member accounts in Supabase Auth. The service-role key stays server-side; the Express API checks the signed-in user before serving application data.

## Google Drive

Create a Google service account, share the poster folder with its email as a viewer, then set `GOOGLE_SERVICE_ACCOUNT_JSON` and `GOOGLE_DRIVE_FOLDER_ID`. The Drive integration uses read-only scope and imports images into the poster library.

## Viber publishing

The official Viber bot REST API supports sending messages to people who subscribed to the bot. Broadcast messages require Viber approval. The documented public-chat post endpoint is for a Public Account's public chat; the API does not offer posting to arbitrary Viber groups/channels. Bot creation has been on commercial terms since February 5, 2024. See the [official REST API](https://developers.viber.com/docs/api/rest-bot-api/).

Set `VIBER_AUTH_TOKEN` only after obtaining a bot commercially through Viber. The send endpoint accepts subscribed user IDs and records each result. Group/community distribution uses assisted sharing from the app so a team member can select a destination in Viber.

## Scheduling and history

Schedules are stored in Supabase when configured. The server checks every minute and marks due items as ready to share, then adds them to posting history. It does not claim a post was published to a Viber group automatically. Direct bot-send outcomes are recorded individually.
