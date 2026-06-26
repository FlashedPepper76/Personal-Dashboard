# life-dashboard — setup

Database is already provisioned (Supabase project `life-dashboard`, tables created, RLS on).
What's left is two account setups only you can do, then deploying to Netlify.

## 1. Google Cloud OAuth client (for Gmail + Drive)

1. Go to https://console.cloud.google.com/ and create a new project (e.g. "life-dashboard").
2. In the search bar, find **Gmail API** → click **Enable**.
3. Same for **Google Drive API** → **Enable**.
4. Go to **APIs & Services → OAuth consent screen**.
   - User type: External (unless you have a Google Workspace org — then Internal is fine).
   - Fill in app name + your email. Scopes don't need to be added here.
   - Add yourself as a **test user** (your Gmail address) — this keeps the app in "testing" mode, which is fine for a personal-use app and avoids Google's verification process.
5. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
   - Application type: **Web application**
   - Authorized redirect URI: `https://YOUR-SITE-NAME.netlify.app/api/google-auth-callback` (swap in your real Netlify site name once it exists — you can edit this later)
6. Copy the **Client ID** and **Client Secret** into your `.env` / Netlify env vars.

## 2. Apple app-specific password (for iCloud Calendar)

1. Go to https://appleid.apple.com → sign in.
2. Under **Sign-In and Security**, find **App-Specific Passwords** → generate one, name it something like "life-dashboard".
3. Put that password (not your real Apple ID password) in `ICLOUD_APP_PASSWORD`, and your Apple ID email in `ICLOUD_APPLE_ID`.

This password only grants CalDAV-style access, not full account access — and you can revoke it anytime from the same page.

## 3. Deploy

1. Push this folder to a new GitHub repo (same flow as `eye-auth-helper`).
2. In Netlify: **Add new site → Import from Git**, pick the repo.
3. Add all the env vars from `.env.example` (filled in) under **Site settings → Environment variables**.
4. Once deployed, visit `https://YOUR-SITE.netlify.app/api/google-auth-start` once — that's the link that connects your Gmail + Drive.

## What's already done vs. what's next

- ✅ Supabase project + schema (`emails`, `drive_files`, `calendar_events`, `todos`, `fun_facts`, `integration_tokens`)
- ✅ Google OAuth start/callback functions
- ✅ Frontend mockup moved in as the starting `public/index.html`
- ⬜ Sync functions (Gmail pull, Drive pull, iCloud CalDAV pull, todo extraction, fun fact) — next step, once the two accounts above exist
- ⬜ Simple login lock screen so the dashboard isn't public
