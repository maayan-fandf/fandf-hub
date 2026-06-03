#!/usr/bin/env bash
# Idempotent deploy for the cloud-hosted price scraper. Re-running this
# script on a no-op change is safe — it'll rebuild the image (free if
# nothing changed thanks to Cloud Build's layer cache) and update the
# Cloud Run job + Cloud Scheduler trigger in place.
#
# First-time setup:
#   1. Run `./scraper/upload-secrets.sh` ONCE to push the SA key + sheet
#      IDs to Secret Manager (reads them from .env.local).
#   2. Run THIS script. It builds, deploys the job, and schedules it.
#
# Subsequent runs (e.g. after editing scrape-landing-prices.mjs):
#   Just re-run this script.
#
# Expects gcloud auth already done and the active project set to
# fandf-dashboard:
#   gcloud config set project fandf-dashboard
set -euo pipefail

# ── Config (in sync with .firebaserc / the existing App Hosting setup) ──
PROJECT_ID="fandf-dashboard"
REGION="europe-west4"                          # Same region as App Hosting
JOB_NAME="fandf-price-scraper"
REPO_NAME="fandf-scraper"                      # Artifact Registry repo
IMAGE_TAG="latest"
SCHEDULER_JOB="daily-price-scrape"
SCHEDULE_CRON="0 3 * * *"                      # 03:00 daily
SCHEDULE_TZ="Asia/Jerusalem"
RUNTIME_SA="price-scraper@${PROJECT_ID}.iam.gserviceaccount.com"

REPO_PATH="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}"
IMAGE_URI="${REPO_PATH}/${JOB_NAME}:${IMAGE_TAG}"

# ── 1. Artifact Registry repo ────────────────────────────────────────
if ! gcloud artifacts repositories describe "$REPO_NAME" --location="$REGION" --project="$PROJECT_ID" > /dev/null 2>&1; then
  echo "→ creating Artifact Registry repo $REPO_NAME in $REGION"
  gcloud artifacts repositories create "$REPO_NAME" \
    --repository-format=docker \
    --location="$REGION" \
    --project="$PROJECT_ID" \
    --description="Container images for the F&F nightly price scraper"
else
  echo "✓ Artifact Registry repo $REPO_NAME exists"
fi

# ── 2. Runtime service account for the Cloud Run job ─────────────────
# This is NOT the DWD-enabled SA whose key the scraper uses to read/write
# sheets. It's the GCP identity the Cloud Run container itself runs as —
# only needs to read secrets + write logs.
if ! gcloud iam service-accounts describe "$RUNTIME_SA" --project="$PROJECT_ID" > /dev/null 2>&1; then
  echo "→ creating runtime SA $RUNTIME_SA"
  gcloud iam service-accounts create price-scraper \
    --display-name="F&F price scraper Cloud Run runtime" \
    --project="$PROJECT_ID"
  echo "→ granting secret read"
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$RUNTIME_SA" \
    --role="roles/secretmanager.secretAccessor" \
    --condition=None > /dev/null
else
  echo "✓ runtime SA $RUNTIME_SA exists"
fi

# ── 3. Build the image via Cloud Build ───────────────────────────────
echo "→ building $IMAGE_URI"
# Build context = the fandf-hub root (so Dockerfile can COPY lib/ + scripts/).
# Use the scraper/.dockerignore + scraper/Dockerfile explicitly.
(
  cd "$(dirname "$0")/.." && \
  gcloud builds submit \
    --project="$PROJECT_ID" \
    --region="$REGION" \
    --tag="$IMAGE_URI" \
    --gcs-source-staging-dir="gs://${PROJECT_ID}_cloudbuild/source" \
    --config=scraper/cloudbuild.yaml \
    .
)

# ── 4. Deploy / update the Cloud Run job ─────────────────────────────
echo "→ deploying Cloud Run job $JOB_NAME"
gcloud run jobs deploy "$JOB_NAME" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --image="$IMAGE_URI" \
  --service-account="$RUNTIME_SA" \
  --max-retries=1 \
  --task-timeout=30m \
  --memory=2Gi \
  --cpu=2 \
  --set-secrets="TASKS_SA_KEY_JSON=TASKS_SA_KEY_JSON:latest,SHEET_ID_COMMENTS=SHEET_ID_COMMENTS:latest,DRIVE_FOLDER_OWNER=DRIVE_FOLDER_OWNER:latest"

# ── 5. Schedule it via Cloud Scheduler ───────────────────────────────
# Cloud Scheduler hits the Cloud Run Jobs admin API to launch executions.
# Needs an OIDC token + the runtime role `roles/run.invoker` on the job
# (granted to the scheduler SA below).
SCHEDULER_SA="cloud-scheduler@${PROJECT_ID}.iam.gserviceaccount.com"
if ! gcloud iam service-accounts describe "$SCHEDULER_SA" --project="$PROJECT_ID" > /dev/null 2>&1; then
  echo "→ creating scheduler SA $SCHEDULER_SA"
  gcloud iam service-accounts create cloud-scheduler \
    --display-name="Cloud Scheduler — Cloud Run job invoker" \
    --project="$PROJECT_ID"
fi
echo "→ granting run.invoker on the job"
gcloud run jobs add-iam-policy-binding "$JOB_NAME" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --member="serviceAccount:$SCHEDULER_SA" \
  --role="roles/run.invoker" > /dev/null

JOB_RUN_URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${JOB_NAME}:run"

if gcloud scheduler jobs describe "$SCHEDULER_JOB" --location="$REGION" --project="$PROJECT_ID" > /dev/null 2>&1; then
  echo "→ updating existing scheduler job $SCHEDULER_JOB"
  gcloud scheduler jobs update http "$SCHEDULER_JOB" \
    --project="$PROJECT_ID" \
    --location="$REGION" \
    --schedule="$SCHEDULE_CRON" \
    --time-zone="$SCHEDULE_TZ" \
    --uri="$JOB_RUN_URI" \
    --http-method=POST \
    --oauth-service-account-email="$SCHEDULER_SA"
else
  echo "→ creating scheduler job $SCHEDULER_JOB"
  gcloud scheduler jobs create http "$SCHEDULER_JOB" \
    --project="$PROJECT_ID" \
    --location="$REGION" \
    --schedule="$SCHEDULE_CRON" \
    --time-zone="$SCHEDULE_TZ" \
    --uri="$JOB_RUN_URI" \
    --http-method=POST \
    --oauth-service-account-email="$SCHEDULER_SA" \
    --description="Nightly trigger for the F&F price scraper. Edits: change schedule via Cloud Scheduler GUI; change job behaviour via fandf-hub repo + re-run deploy.sh."
fi

echo
echo "Done. Verify:"
echo "  gcloud run jobs describe $JOB_NAME --region=$REGION --project=$PROJECT_ID"
echo "  gcloud scheduler jobs describe $SCHEDULER_JOB --location=$REGION --project=$PROJECT_ID"
echo
echo "Trigger a one-off run now (instead of waiting for 03:00):"
echo "  gcloud run jobs execute $JOB_NAME --region=$REGION --project=$PROJECT_ID --wait"
