#!/usr/bin/env bash
# One-time secret upload — pushes the three scraper secrets from your
# local .env.local to GCP Secret Manager so the Cloud Run job can mount
# them at runtime.
#
# Run this ONCE before the first ./deploy.sh. Re-running it is safe —
# Secret Manager versions each value, the Run job's `--set-secrets=...
# :latest` always reads the newest. So if you ever need to rotate the
# SA key, just re-run this.
set -euo pipefail

PROJECT_ID="fandf-dashboard"
ENV_FILE="$(dirname "$0")/../.env.local"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE — copy from .env.local.example and fill in values first."
  exit 1
fi

# Read the three vars from .env.local (each may span a single line; the
# SA key JSON is on one line per the project convention).
extract() {
  local name="$1"
  grep -E "^${name}=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed -E 's/^"//; s/"$//'
}

TASKS_SA_KEY_JSON="$(extract TASKS_SA_KEY_JSON)"
SHEET_ID_COMMENTS="$(extract SHEET_ID_COMMENTS)"
DRIVE_FOLDER_OWNER="$(extract DRIVE_FOLDER_OWNER)"

for name in TASKS_SA_KEY_JSON SHEET_ID_COMMENTS DRIVE_FOLDER_OWNER; do
  if [ -z "${!name}" ]; then
    echo "Missing $name in .env.local — aborting."
    exit 1
  fi
done

upsert() {
  local name="$1" value="$2"
  if gcloud secrets describe "$name" --project="$PROJECT_ID" > /dev/null 2>&1; then
    echo "→ adding new version to $name"
    printf "%s" "$value" | gcloud secrets versions add "$name" \
      --project="$PROJECT_ID" \
      --data-file=- > /dev/null
  else
    echo "→ creating secret $name"
    printf "%s" "$value" | gcloud secrets create "$name" \
      --project="$PROJECT_ID" \
      --replication-policy=automatic \
      --data-file=- > /dev/null
  fi
}

upsert TASKS_SA_KEY_JSON "$TASKS_SA_KEY_JSON"
upsert SHEET_ID_COMMENTS "$SHEET_ID_COMMENTS"
upsert DRIVE_FOLDER_OWNER "$DRIVE_FOLDER_OWNER"

echo
echo "Done. Verify:"
echo "  gcloud secrets list --project=$PROJECT_ID --filter=\"name:TASKS_SA_KEY_JSON OR name:SHEET_ID_COMMENTS OR name:DRIVE_FOLDER_OWNER\""
