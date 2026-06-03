# Cloud-hosted price scraper

The nightly Puppeteer scraper runs as a **Cloud Run Job** triggered by
**Cloud Scheduler** at 03:00 IL time, in the same GCP project as the
Next.js hub (`fandf-dashboard`, region `europe-west4`). No dedicated PC
needed.

```
Cloud Scheduler (03:00 IL)  →  Cloud Run Job: fandf-price-scraper
                                  ↓
                                Puppeteer + system Chromium
                                  ↓
                                LANDING_PRICES tab on dashboard-comments
```

## Files in this folder

| File | Purpose |
|------|---------|
| `Dockerfile` | Image build — node:22-slim + system chromium + scraper code |
| `package.json` | Slim runtime deps (no Next.js) — google-auth-library, googleapis, puppeteer |
| `.dockerignore` | Limits the build context to just the files the scraper needs |
| `cloudbuild.yaml` | Cloud Build step used by deploy.sh |
| `upload-secrets.sh` | One-time: push SA key + sheet IDs from .env.local → Secret Manager |
| `deploy.sh` | Idempotent: builds image, deploys job, schedules it |

## First-time setup

Pre-reqs: gcloud auth set up + active project set to `fandf-dashboard`:

```bash
gcloud auth login
gcloud config set project fandf-dashboard
```

Then:

```bash
# 1. Push secrets from .env.local to Secret Manager. One-off.
./scraper/upload-secrets.sh

# 2. Build image, deploy Run job, schedule it.
./scraper/deploy.sh

# 3. Trigger a one-off run NOW (don't wait for 03:00 to validate).
gcloud run jobs execute fandf-price-scraper \
  --region=europe-west4 \
  --project=fandf-dashboard \
  --wait
```

The first deploy takes ~5 min (image build + puppeteer download in the
Cloud Build context). Subsequent deploys are ~1 min thanks to layer
caching.

## Cost

Single execution: ~5 min CPU time × 2 vCPU × ~1 GB RAM per night.
GCP free tier covers ~240 min × vCPU + ~450 min × GB-RAM per day for
Cloud Run, so well below the free threshold. Expected monthly cost:
**\$0**.

## Verify the schedule

```bash
gcloud scheduler jobs describe daily-price-scrape \
  --location=europe-west4 \
  --project=fandf-dashboard
```

Last execution's logs:

```bash
gcloud run jobs executions list \
  --job=fandf-price-scraper \
  --region=europe-west4 \
  --project=fandf-dashboard \
  --limit=5

# Then for a specific execution:
gcloud beta run jobs executions logs read EXECUTION_ID \
  --region=europe-west4 \
  --project=fandf-dashboard
```

## Updating the scraper

When `scripts/scrape-landing-prices.mjs` or `lib/priceExtractor.ts`
change, re-run:

```bash
./scraper/deploy.sh
```

That rebuilds the image and updates the Cloud Run job in place — no
schedule change needed.

## Rotating the SA key

Update `TASKS_SA_KEY_JSON` in `.env.local`, then:

```bash
./scraper/upload-secrets.sh
```

Adds a new secret version. The Cloud Run job's `:latest` reference
picks it up on the next execution — no redeploy needed.

## Yad2 from a cloud IP — known risk

GCP egress IPs are well-known to anti-bot services. Yad2 may rate-limit
or block them aggressively. **Landing pages, FB, Google all work fine
from GCP** — only Yad2 is at risk.

Mitigations (in increasing order of effort):
1. Wait 3–4 nights, see if Yad2 fetch-error rate stabilises (sometimes
   anti-bot is behaviour-based, not IP-based).
2. Add a residential proxy for the Yad2 portion only — Smartproxy /
   Bright Data ~\$15/mo for our request volume.
3. Move Yad2 back to a residential PC (the local `.env.local` flow
   still works there).

The morning-feed price-mismatch alert remains useful with just landing +
FB + Google — Yad2 was an addition, not a baseline.

## Disabling the schedule (without deleting it)

```bash
gcloud scheduler jobs pause daily-price-scrape \
  --location=europe-west4 --project=fandf-dashboard
# To resume:
gcloud scheduler jobs resume daily-price-scrape \
  --location=europe-west4 --project=fandf-dashboard
```
