# Google OAuth setup

One-time setup so your Hub can sign real users in with Google.

## 1. Create OAuth credentials in Google Cloud Console

1. Go to <https://console.cloud.google.com/apis/credentials>
2. Pick the same Google Cloud project your Apps Script lives under (or any
   project — these are independent from the Apps Script one).
3. If prompted, configure the **OAuth consent screen** first:
   - User type: **Internal** (if you have a Google Workspace — limits sign-in to
     your domain) or **External** (if you want external clients to sign in too)
   - App name: `Hub`
   - User support email: your email
   - Developer contact: your email
   - Scopes: leave the defaults (email, profile, openid)
   - Save and continue.
4. Back on Credentials → **Create Credentials → OAuth client ID**:
   - Application type: **Web application**
   - Name: `Hub (localhost + prod)`
   - **Authorized JavaScript origins:** add
     - `http://localhost:3000`
     - (later) `https://<your-firebase-app>.web.app`
   - **Authorized redirect URIs:** add
     - `http://localhost:3000/api/auth/callback/google`
     - (later) `https://<your-firebase-app>.web.app/api/auth/callback/google`
   - Click **Create**.
5. Copy the **Client ID** and **Client secret** shown.

## 2. Generate AUTH_SECRET

This is a random string used to sign session cookies. Any of:

```bash
openssl rand -hex 32
# or
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 3. Paste into .env.local

```
AUTH_SECRET=<the hex string from step 2>
AUTH_GOOGLE_ID=<the Client ID from step 1.5>
AUTH_GOOGLE_SECRET=<the Client secret from step 1.5>
```

Remove `DEV_USER_EMAIL` when you're ready — once OAuth works you don't need it.

## 4. Restart the dev server

```powershell
cd hub-next
npm run dev
```

Visit <http://localhost:3000>. You should be redirected to `/signin` → click
**Continue with Google** → sign in → land on the project list.

## 5. What happens after sign-in

- If your email is in `CONFIG.ADMIN_EMAILS` in `Code.js`, you're admin and see
  all projects.
- If your email is on a project's row in the `Keys` tab (either the
  `EMAIL Manager` or `Email Client` column), you see those projects.
- Otherwise you're redirected to `/unauthorized` with instructions to request
  access. Sign-out works from there too.

## Adding to production later

When you deploy to Firebase App Hosting:

1. Add the production URL to **both** "JavaScript origins" and "Redirect URIs"
   in the OAuth client config.
2. Set the same env vars (`AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`,
   `APPS_SCRIPT_API_URL`, `APPS_SCRIPT_API_TOKEN`) in the Firebase console →
   App Hosting → Environment variables.
3. Remove `DEV_USER_EMAIL` from production env — it's a dev-only fallback.
