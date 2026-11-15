# LINKSERVE POSTER MANAGEMENT SYSTEM

This existing React + Vite dashboard and Express API manages poster metadata in Supabase and poster images in a private Supabase Storage bucket. It supports administrator sign-in, poster status views, scheduling reminders, manual Viber Community sharing, and an append-only publication history.

## Run locally

1. Use Node.js 20 or newer.
2. Set the Supabase variables in `.env` using `.env.example` as a guide.
3. Run `npm install`, then run `supabase/schema.sql` in the Supabase SQL editor.
4. Assign the `admin` app-metadata role to the administrator account (see **Administrator access**).
5. Run `npm run dev` and open the Vite URL shown in the terminal.

Without Supabase, the app uses sample data. Poster uploads and durable data require the configured Supabase project.

## Supabase setup and security

Set these variables in the local server environment and in the Render service:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` — server-side only; never expose or prefix with `VITE_`
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY` — public client key; protected operations are enforced by the API

Run [`supabase/schema.sql`](supabase/schema.sql) in the Supabase SQL editor. It upgrades the existing poster, schedule, and history tables, preserves their rows, creates the private `linkserve-posters` bucket, and adds duplicate/schedule indexes and administrator-only Storage policies. Poster uploads and deletions go through the authenticated Express API; image reads use short-lived signed URLs.

### Administrator access

Only users whose Supabase Auth `app_metadata` contains `"role": "admin"` can use the API. Set that claim securely from the Supabase SQL editor for your administrator account (replace the email):

```sql
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"admin"}'::jsonb
where email = 'YOUR_ADMIN_EMAIL';
```

Sign out and back in after setting the role so the refreshed access token includes the claim. Do not set this role in user-editable `user_metadata`.

Uploads accept JPEG, PNG, WebP, GIF, or AVIF images up to 20 MB. The server verifies the image signature, computes SHA-256 from the uploaded bytes, and rejects duplicate image hashes. A private bucket and signed URLs keep poster access behind the authenticated application.

## Scheduling, Viber, and publication history

Scheduling is a reminder only. At or after its scheduled time, a scheduled item is marked **Ready to share** when the application checks schedules; the dashboard polls while open and shows an in-app reminder. It is never automatically published. You can edit or cancel an active schedule.

**Share to Viber** uses browser file sharing where supported. Otherwise, download the image and open Viber, then choose your existing Community and send it manually. No caption is attached, and the application does not claim to publish automatically to Viber Communities. After sending, confirm in the app to append a publication-history entry. Republishing asks for confirmation and adds a **Republished** entry without overwriting prior history.

## Existing posters

Existing poster records and relationships are retained. The migration maps the previous `ready` poster status to `available` and preserves image URLs for existing records. Existing images that were stored only in Google Drive cannot be migrated by this app after the Drive integration is removed; download those images from their current source and upload them again to Supabase Storage. New poster uploads no longer use local folders, Google Drive, or Google OAuth.

## Deploy on Render

The included [`render.yaml`](render.yaml) builds the Vite frontend and serves it with Express. Configure the four Supabase variables above in Render's Environment settings, run the schema migration in Supabase, set the administrator app-metadata role, and deploy. The server must have the service-role key; do not put it in frontend variables.

Render's free Web Services sleep after inactivity. In-app reminders are shown when the dashboard is open and polling; they are not a guaranteed push notification while the service or browser is closed.
