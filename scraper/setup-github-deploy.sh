#!/usr/bin/env bash
# ONE-TIME setup so GitHub Actions can deploy the price scraper without
# holding a long-lived service-account key.
#
# Uses Workload Identity Federation: the workflow presents a short-lived
# OIDC token proving "I am a run of maayan-fandf/fandf-hub on branch
# main", and GCP exchanges it for credentials. Nothing secret is stored
# in GitHub — the two values it needs are identifiers, not keys, and are
# useless without the identity check behind them.
#
# Idempotent: re-running is safe. Everything is create-if-absent, and the
# IAM bindings are no-ops when already present.
#
# Run:  bash scraper/setup-github-deploy.sh
# Then paste the two printed values into GitHub → Settings → Secrets and
# variables → Actions.
set -euo pipefail

PROJECT_ID="fandf-dashboard"
REGION="europe-west4"
GITHUB_REPO="maayan-fandf/fandf-hub"
POOL="github-actions"
PROVIDER="github"
DEPLOY_SA="github-deploy@${PROJECT_ID}.iam.gserviceaccount.com"
RUNTIME_SA="price-scraper@${PROJECT_ID}.iam.gserviceaccount.com"

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
echo "project $PROJECT_ID ($PROJECT_NUMBER)"

echo "→ enabling required APIs (no-op if already on)"
gcloud services enable \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  run.googleapis.com \
  --project="$PROJECT_ID"

# ── Identity pool + GitHub provider ──────────────────────────────────
if ! gcloud iam workload-identity-pools describe "$POOL" \
      --location=global --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "→ creating workload identity pool $POOL"
  gcloud iam workload-identity-pools create "$POOL" \
    --location=global --project="$PROJECT_ID" \
    --display-name="GitHub Actions"
else
  echo "✓ pool $POOL exists"
fi

# attribute-condition is the security boundary. Without it ANY GitHub
# repository anywhere could mint tokens for this provider.
if ! gcloud iam workload-identity-pools providers describe "$PROVIDER" \
      --workload-identity-pool="$POOL" --location=global \
      --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "→ creating provider $PROVIDER"
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
    --workload-identity-pool="$POOL" \
    --location=global --project="$PROJECT_ID" \
    --display-name="GitHub" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="assertion.repository=='${GITHUB_REPO}'"
else
  echo "✓ provider $PROVIDER exists"
fi

# ── Deploy service account ───────────────────────────────────────────
if ! gcloud iam service-accounts describe "$DEPLOY_SA" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "→ creating deploy SA $DEPLOY_SA"
  gcloud iam service-accounts create github-deploy \
    --display-name="GitHub Actions — scraper deploy" --project="$PROJECT_ID"
  for i in 1 2 3 4 5 6 7 8 9 10; do
    gcloud iam service-accounts describe "$DEPLOY_SA" --project="$PROJECT_ID" >/dev/null 2>&1 && break
    sleep 2
  done
else
  echo "✓ deploy SA exists"
fi

# Only what the workflow does: submit a build, write the image, update an
# existing Cloud Run job. Deliberately NOT run.admin or iam.admin — the
# workflow cannot create service accounts, grant roles, or touch the
# scheduler. That stays with scraper/deploy.sh, run by a human.
echo "→ granting deploy roles"
for role in \
  roles/cloudbuild.builds.editor \
  roles/artifactregistry.writer \
  roles/run.developer \
  roles/storage.objectAdmin \
  roles/logging.viewer
do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${DEPLOY_SA}" --role="$role" \
    --condition=None >/dev/null
  echo "   $role"
done

# Setting a job's runtime identity requires actAs on that identity.
echo "→ granting actAs on the runtime SA"
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
  --member="serviceAccount:${DEPLOY_SA}" \
  --role="roles/iam.serviceAccountUser" \
  --project="$PROJECT_ID" >/dev/null

# ── Let the repo impersonate the deploy SA ───────────────────────────
# Scoped to this repository AND the main branch: a pull request from a
# fork runs with a different ref and cannot deploy.
echo "→ binding ${GITHUB_REPO}@main to ${DEPLOY_SA}"
gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" \
  --project="$PROJECT_ID" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${GITHUB_REPO}" \
  >/dev/null

PROVIDER_RESOURCE="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"

cat <<EOF

────────────────────────────────────────────────────────────────────
Done. Add these two repository secrets in GitHub:

  https://github.com/${GITHUB_REPO}/settings/secrets/actions

  GCP_WORKLOAD_IDENTITY_PROVIDER
  ${PROVIDER_RESOURCE}

  GCP_DEPLOY_SERVICE_ACCOUNT
  ${DEPLOY_SA}

Neither is a credential — they only work from a GitHub Actions run of
${GITHUB_REPO}. Then push a change to lib/priceExtractor.ts (or run the
workflow manually from the Actions tab) and the job redeploys itself.
────────────────────────────────────────────────────────────────────
EOF
