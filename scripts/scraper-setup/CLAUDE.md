# Set up the F&F price scraper on this machine

You're Claude running on a Windows PC the user designated as the dedicated
host for the nightly price scraper. Get the scraper running + scheduled.

The scraper renders every real-estate project's landing page and Yad2
listing via headless Chrome, extracts the headline "starting from"
price, and writes the results to a `LANDING_PRICES` tab on the F&F
dashboard-comments Google Sheet. The hub's morning-feed alert reads
that tab and emits a `price-mismatch` signal when prices disagree
across surfaces.

This document tells you exactly what to do. Don't improvise — every
step is here for a reason. When you finish, the scraper should run
nightly without anyone touching it.

---

## Step 0 — preconditions

Verify these once. If any fail, stop and tell the user.

```powershell
# Node ≥ 22 (needs --experimental-strip-types for the .ts import)
node --version

# Git
git --version

# A writable scraper home — pick one and stick with it
$Env:SCRAPER_HOME = "C:\fandf-scraper"
```

If Node is older than 22, install Node 22 LTS from https://nodejs.org and
re-open the shell.

---

## Step 1 — clone the repo

```powershell
git clone https://github.com/maayan-fandf/fandf-hub.git $Env:SCRAPER_HOME
cd $Env:SCRAPER_HOME
```

Don't fork, don't branch — the scraper just consumes `main`.

---

## Step 2 — install dependencies

```powershell
npm install
```

This pulls Puppeteer + bundled Chromium (~150 MB, one-time). Takes 2–5
minutes on a typical connection. If npm complains about deprecation
warnings, ignore them; the actual install must finish cleanly. If
`npm install` exits non-zero, stop and report the error to the user.

---

## Step 3 — credentials (`.env.local`)

The scraper needs three secrets to read/write the sheet. **Do not invent
values — ask the user to paste them.** Tell the user verbatim:

> "Open the `.env.local` file from your main dev machine
> (`fandf-hub/.env.local`), copy the lines for `SHEET_ID_COMMENTS`,
> `TASKS_SA_KEY_JSON`, and `DRIVE_FOLDER_OWNER`, and paste them here.
> I'll save them to the right place on this PC."

When the user provides them, write them to `$Env:SCRAPER_HOME\.env.local`:

```powershell
@"
SHEET_ID_COMMENTS=<paste>
TASKS_SA_KEY_JSON=<paste, the whole JSON on one line>
DRIVE_FOLDER_OWNER=<paste, e.g. maayan@fandf.co.il>
"@ | Out-File -FilePath ".env.local" -Encoding utf8 -NoNewline
```

Verify the file's not empty and the JSON looks structurally valid:

```powershell
Get-Content .env.local | Measure-Object -Line
node -e "const env = require('fs').readFileSync('.env.local','utf8'); const m = env.match(/TASKS_SA_KEY_JSON=(.+)/); JSON.parse(m[1]); console.log('SA key parses ok')"
```

---

## Step 4 — dry run

Run the scraper on a single project to confirm everything wired up
correctly. Don't run the full portfolio yet — that's ~10 minutes and
not needed for verification.

```powershell
node --experimental-strip-types scripts/scrape-landing-prices.mjs "אחוזת אפרידר"
```

Expected: one line of output like
```
ok           אחוזת אפרידר                 web=…  yad2=…  (xxxxxms)
Wrote 1 rows to LANDING_PRICES:  ok=… no-price=… error=…
```

The web price may be `—` (afridar is JS-rendered behind a form) — that's
fine, you're verifying plumbing, not data quality. What you need:

- No exception thrown
- The "Landing col" / "Yad2 col" log line near the top shows non-`-1`
  column indices (means Keysimp is readable)
- A new row written to the LANDING_PRICES tab

If any of those fail: read the actual error, don't guess. Auth errors →
`.env.local` is wrong. Tab-not-found errors → `SHEET_ID_COMMENTS` is
wrong, or the `Keysimp` tab on that sheet has been renamed. Browser
launch errors → re-run `npm install puppeteer`.

---

## Step 5 — schedule it

Run `schedule.ps1` from this same folder (it's a sibling of this file):

```powershell
.\scripts\scraper-setup\schedule.ps1
```

The script creates a Windows Task Scheduler entry named
`fandf-price-scraper` that runs the scraper every day at 03:00 local
time. The user can change the time later via Task Scheduler GUI.

Verify the task exists:

```powershell
Get-ScheduledTask -TaskName "fandf-price-scraper" | Format-List TaskName, State, Triggers
```

---

## Step 6 — finalise

Tell the user verbatim:

> "Scraper is installed at `$Env:SCRAPER_HOME` and scheduled to run
> nightly at 03:00 local time. The first scheduled run will land on
> the next 03:00 — until then the LANDING_PRICES tab has the dry-run
> data from one project plus whatever's there from your earlier runs.
> If you want to trigger a full run right now: `cd $Env:SCRAPER_HOME;
> node --experimental-strip-types scripts/scrape-landing-prices.mjs`.
> It takes ~10 minutes for all 39 projects."

Don't run the full scrape yourself — wait for the user to ask.

---

## Updating the scraper later

When the hub repo gets a new commit affecting the scraper or extractor:

```powershell
cd $Env:SCRAPER_HOME
git pull origin main
# If package.json changed, also:
npm install
```

No re-schedule needed; the Task Scheduler entry calls into the same
folder and picks up new code automatically.

## Troubleshooting

- **"Cannot find module 'puppeteer'"** → `npm install` didn't finish.
  Re-run it from `$Env:SCRAPER_HOME`.
- **"401 Unauthorized" on sheet read** → `TASKS_SA_KEY_JSON` or
  `DRIVE_FOLDER_OWNER` is wrong. Re-paste from the source machine.
- **Lots of "fetch-error" / 25s timeouts** → the host has slow internet
  or is behind a strict firewall. Try rerunning; if persistent, ask
  the user.
- **Yad2 returns blank pages** → bot detection. Yad2 hits this when
  the same IP runs many searches in a row. The scraper paces requests
  per project (5–10s each) which usually avoids it, but if it kicks
  in, just wait 10 minutes and rerun.
