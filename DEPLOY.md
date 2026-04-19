# Deploying the Hub to Firebase App Hosting

One-time setup, then deploys happen automatically on every push to your GitHub
repo's main branch.

## 0. Prerequisites

- A GitHub account
- The `fandf-dashboard` Google Cloud project (you already use this for Apps
  Script and the OAuth client)
- Firebase CLI installed locally (for secret management):

  ```powershell
  npm install -g firebase-tools
  firebase login
  ```

## 1. Push `hub-next` to its own GitHub repo

Firebase App Hosting deploys from a GitHub repo, so the hub needs to live in
one. Keep it separate from the Apps Script project — different tech, different
lifecycle.

```powershell
cd "C:/Users/sachs/OneDrive/מסמכים/claude/hub-next"

git init
git add .
git commit -m "Initial hub commit"

# Create an empty private repo on github.com called e.g. "fandf-hub"
# (DON'T initialize it with a README — keep it empty). Then:

git branch -M main
git remote add origin https://github.com/<your-username>/fandf-hub.git
git push -u origin main
```

Check the repo on GitHub — you should see `app/`, `components/`, `lib/`,
`package.json`, etc. Crucially confirm **`.env.local` is NOT there** (it's
gitignored).

## 2. Enable Firebase on the GCP project

1. Go to <https://console.firebase.google.com/>
2. **Add project** → choose "Use an existing Google Cloud project" → pick
   `fandf-dashboard`
3. Skip Google Analytics (not needed)
4. Wait for Firebase to finish provisioning

## 3. Store secrets in Google Cloud Secret Manager

From your hub-next folder:

```powershell
firebase apphosting:secrets:set APPS_SCRIPT_API_URL
# Paste: https://script.google.com/macros/s/AKfycbzWF_rXfqnRtvCC9QDKvHNNqAERxSnpoSqpqCvbZEalTuND3diSu9FL0WbQcr9dYy4HUA/exec

firebase apphosting:secrets:set APPS_SCRIPT_API_TOKEN
# Paste: 5526ada10d90a84e08342ca6a65a6ce228b0b0826e23a124a8abaab8cb9d661b

firebase apphosting:secrets:set AUTH_SECRET
# Generate a fresh one for prod — do NOT reuse the dev secret:
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

firebase apphosting:secrets:set AUTH_GOOGLE_ID
# Paste the Client ID from Google Cloud Console → Credentials

firebase apphosting:secrets:set AUTH_GOOGLE_SECRET
# Paste the Client secret from Google Cloud Console → Credentials
```

Each command prompts for the value interactively. The CLI stores it in Secret
Manager and grants the App Hosting service account access.

## 4. Create the App Hosting backend

1. In the Firebase console, left sidebar → **Build → App Hosting**
2. Click **Get started** → **Create backend**
3. **Region:** pick closest to your users (`europe-west1` or `europe-west3` for
   Israel)
4. **Connect to GitHub:** authorize the Firebase GitHub app, pick your
   `fandf-hub` repo
5. **Root directory:** `/` (hub-next is the whole repo; if you made it a
   subdirectory, enter the path)
6. **Branch:** `main`
7. **Automatic rollouts:** ON (every push to `main` deploys)
8. Backend ID: `hub` or similar short name
9. Click **Finish and deploy**

First build kicks off. Watch it in the console — takes ~3-5 minutes.

## 5. Update the OAuth redirect URI

Once the first build succeeds, Firebase gives you a production URL like
`https://hub--fandf-dashboard.web.app`.

Go back to <https://console.cloud.google.com/auth/clients?project=fandf-dashboard>
→ click your **Hub** OAuth client → add to BOTH lists:

- **Authorized JavaScript origins:**
  `https://hub--fandf-dashboard.web.app`
- **Authorized redirect URIs:**
  `https://hub--fandf-dashboard.web.app/api/auth/callback/google`

Save. OAuth changes propagate in a minute or two.

## 6. Test

Visit your prod URL. Sign in with Google. You should land on the Projects page,
same as localhost.

If the sign-in errors with `redirect_uri_mismatch`, wait a minute and retry —
the new redirect URI takes time to propagate.

## 7. Future deploys

Just push to `main`:

```powershell
git add .
git commit -m "describe the change"
git push
```

Firebase rebuilds and rolls out automatically.

---

## Adding a custom domain

This was done for `hub.fandf.co.il`. DNS is managed at **upress.io**, the
GCP/Firebase project is `fandf-dashboard`.

### 1. In Firebase Console
- **App Hosting** → `fandf-hub` backend → **Custom domains** → **Add domain**
- Enter the subdomain, e.g. `hub.fandf.co.il`
- Firebase shows a single A record to add:
  - Type: `A`
  - Host: `hub` (i.e. for `hub.fandf.co.il`)
  - Value: **`35.219.200.96`** ← this is what Firebase gave us; Firebase MAY
    give a different IP for a new setup, always trust the console.
- Firebase may also request a TXT verification record. Ours didn't; yours
  might. If so, add it exactly as shown.

### 2. At the DNS registrar (upress)
upress auto-created a default subdomain template with extra records (MX,
SPF, www, ftp, autodiscover, NS). **Only the A record is required for the
Firebase app to work.** The others are unused but mostly harmless. To keep
things clean you can delete:
- `A ftp.hub.fandf.co.il` (upress FTP hosting)
- `A www.hub.fandf.co.il` (upress landing page)
- `MX hub.fandf.co.il` (unused — we don't have `@hub` mail)
- `SRV _autodiscover._tcp.hub.fandf.co.il`
- `TXT hub.fandf.co.il` with `v=spf1 ...` (unused without matching MX)

**Keep:**
- `A hub.fandf.co.il → 35.219.200.96` (the Firebase one)
- `NS hub.fandf.co.il → ns1/ns2.upress.io` (likely required by upress)

### 3. After DNS propagates
DNS usually resolves in 5–30 min at upress. Check with
[dnschecker.org](https://dnschecker.org) or `dig hub.fandf.co.il A`.

Firebase provisions an SSL cert automatically (Let's Encrypt, ~5 min after
the record resolves). Visit `https://hub.fandf.co.il` to confirm it loads.

### 4. Update hub + Google for the new URL
Without these, Google sign-in will fail on the new URL.

**a) `AUTH_URL` env var** — Firebase Console → App Hosting → backend →
Environment variables. Change from
`https://fandf-hub--fandf-dashboard.europe-west4.hosted.app`
→ `https://hub.fandf.co.il`. Triggers a redeploy.

**b) OAuth redirect URI** — Google Cloud Console →
[Credentials](https://console.cloud.google.com/apis/credentials) → your Hub
OAuth client → Authorized redirect URIs → add
`https://hub.fandf.co.il/api/auth/callback/google`. Keep the old one too
(in case you ever roll back).

**c) `HUB_URL` Apps Script property** — Apps Script editor → Project
Settings → Script properties → `HUB_URL` → `https://hub.fandf.co.il`.
The daily mention-digest email uses this for the CTA button.

The old Firebase default URL keeps working in parallel — both map to the
same backend. Only AUTH and the mention email CTA care about the canonical
URL.

### Gotcha to remember
**Don't touch apex (`fandf.co.il`) DNS records.** Mail delivery for
`@fandf.co.il` depends on MX/SPF/DKIM/DMARC TXT records there. All
subdomain records are safe. A CNAME on the apex would break mail;
never do that.
