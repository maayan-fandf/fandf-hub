# Hub (Next.js)

A lightweight companion app to the `dashboard-clasp` Apps Script dashboard.
Reads project + task data from the dashboard's Sheets via a thin Apps Script
JSON API; writes nothing yet.

v1 scope: **Task board per project** — surfaces all open tasks that were
spawned from `@`-mentions on dashboard comments, grouped by assignee.

---

## One-time setup

### 1. Create the Apps Script API deployment

The dashboard already has one deployment (`USER_ACCESSING`, serves the HTML).
The hub needs a **second** deployment that runs server-side:

1. Open the Apps Script project (same script, same code).
2. **Deploy → New deployment**.
3. Type: **Web app**.
4. **Execute as:** `Me (your-admin-email@…)` — the script must run as a user
   who can open the Sheets.
5. **Who has access:** `Anyone` (or `Anyone within <domain>` if you can
   guarantee the hub will always call from the same Google domain — simpler
   but less flexible). Either way, the shared secret is the real auth.
6. Copy the **Web app URL** — this is your `APPS_SCRIPT_API_URL`.

### 2. Generate and set the shared secret

Generate a long random token:

```bash
openssl rand -hex 32
# or, if openssl isn't handy:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

In the Apps Script editor: **Project Settings → Script properties →
Add script property**, name `HUB_API_TOKEN`, value `<the token you just
generated>`. Save.

### 3. Configure the hub's env vars

```bash
cd hub-next
cp .env.local.example .env.local
```

Fill in `.env.local`:

```
APPS_SCRIPT_API_URL=https://script.google.com/macros/s/AKfyc…/exec
APPS_SCRIPT_API_TOKEN=<same token you set in ScriptProperties>
DEV_USER_EMAIL=<your admin email, for now>
```

`DEV_USER_EMAIL` is a stand-in until we wire up Google OAuth (NextAuth).
It impersonates that user for access checks — keep it admin-level in dev so
you can see everything.

### 4. Install + run

```bash
npm install
npm run dev
```

Visit <http://localhost:3000>.

---

## Smoke test the API directly

```bash
curl "https://script.google.com/macros/s/AKfyc…/exec?api=1&action=ping&token=YOUR_TOKEN&user=you@example.com"
# → {"ok":true,"user":"you@example.com","at":"2026-..."}
```

```bash
curl "https://script.google.com/macros/s/AKfyc…/exec?api=1&action=myProjects&token=YOUR_TOKEN&user=you@example.com"
# → {"projects":["Project A","Project B",...],"isAdmin":true,"email":"..."}
```

---

## Deployment (Firebase App Hosting)

For v1 we run locally. When you're ready to deploy:

1. `npm i -g firebase-tools` (if not already installed).
2. `firebase init apphosting` from this folder — pick the project, pick this
   directory as the Next.js root.
3. Firebase App Hosting natively supports Next.js 15 SSR. It builds and
   deploys on push to your connected repo.
4. Set the same env vars (`APPS_SCRIPT_API_URL`, `APPS_SCRIPT_API_TOKEN`,
   eventually the NextAuth ones) in the Firebase console → App Hosting →
   backend → Environment variables.

> Note: I originally flagged "Firebase Hosting + Cloud Functions" as the
> Google-owned option. **App Hosting** is the modern equivalent for Next.js
> — same Google billing surface, one deploy target, supports SSR natively.
> Same outcome, fewer moving parts.

---

## What's next (not in v1)

- **Google OAuth via NextAuth** — replaces `DEV_USER_EMAIL`. Verifies the
  end user's identity in the browser, passes the verified email to the API.
- **Admin console** (Feature 2) — UI for editing the `Keys`, `Webhooks`,
  project-member mappings.
- **Mention inbox** (Feature 3) — cross-project view of everything @-ing
  the current user.
- **Project timeline** (Feature 4) — comments + tasks chronologically.

---

## Architecture recap

```
┌──────────────────────┐         ┌─────────────────────────────┐
│  Dashboard (clasp)   │         │  Hub (Next.js, this repo)   │
│  • HtmlService UI    │         │  • Project list             │
│  • Comments / Tasks  │         │  • Task board               │
│  • Deployment A:     │         │  • (future) admin console   │
│    USER_ACCESSING    │         │                             │
└──────────┬───────────┘         └──────────────┬──────────────┘
           │                                    │ GET ?api=1&action=…
           │ reads/writes                       │ (shared secret)
           ▼                                    ▼
     Google Sheets          ◄──── same code ────┤
     (ALL CLIENTS,                              │
      Comments, Keys,       ┌────────────────── ▼ ──────────────┐
      Webhooks)             │  Deployment B: USER_DEPLOYING +   │
                            │  ANYONE_ANONYMOUS                 │
                            │  doGet() routes `api=1` to        │
                            │  _hubApiHandle_ which returns     │
                            │  JSON via ContentService.         │
                            └───────────────────────────────────┘
```

Two deployments, one codebase. The hub never touches Sheets directly —
everything flows through the Apps Script API so access control, caching, and
business logic stay in one place.
