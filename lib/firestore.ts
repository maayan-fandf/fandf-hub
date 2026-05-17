/**
 * Server-only Firestore (Native mode) admin client.
 *
 * Part of the Sheets → Firestore storage migration (see
 * docs/STORAGE_MIGRATION_HANDOFF.md). Phase 0 wiring: this module only
 * constructs the client + names the collections. The dual-write,
 * backfill, and read-cutover live in later phases and import from here.
 *
 * AUTH MODEL — deliberately different from lib/sa.ts:
 *   - lib/sa.ts uses the SA with **domain-wide delegation** to
 *     impersonate the calling F&F user (Sheets/Drive/Gmail access is
 *     gated per-user in Workspace).
 *   - Firestore has no DWD concept. Access is plain GCP IAM on the
 *     service account itself (`roles/datastore.user`). So here we
 *     authenticate as the SA's OWN identity (client_email + private_key
 *     from TASKS_SA_KEY_JSON) with NO `subject`. Row-level access
 *     control stays exactly where it is today — in the lib seam
 *     (getAccessScope etc.), applied in app code after the read. The
 *     Firestore security rules deny ALL client access (server-only);
 *     see firestore.rules.
 *
 * IMPORT SAFETY: the client is constructed lazily in getDb(), never at
 * module load. Importing this file is always safe even when the flag is
 * off or the Firestore API isn't enabled yet — nothing connects until a
 * caller actually asks for the db. Keep it that way (the migration
 * lands behind USE_FIRESTORE_TASKS, default off, until parity is clean).
 *
 * ─── One-time infra the project OWNER must do (Phase 0, cannot be
 *     done from a Claude session — no gcloud on the box, firebase CLI
 *     auth expired, and the SA can't self-grant). No-gcloud path: ────
 *
 *   A. Enable API + create the Native DB (Cloud Console):
 *        https://console.cloud.google.com/firestore?project=fandf-dashboard
 *        → Create database → mode = NATIVE (IRREVERSIBLE; not Datastore)
 *        → location = me-west1 (Tel Aviv) or nam5 if App Hosting is US
 *        (also permanent). Creating the DB auto-enables the API.
 *   B. Grant the migration SA Firestore access (Cloud Console):
 *        https://console.cloud.google.com/iam-admin/iam?project=fandf-dashboard
 *        → Grant access → principal
 *        dashboard-tasks-writer@fandf-dashboard.iam.gserviceaccount.com
 *        → role "Cloud Datastore User" (roles/datastore.user) → Save
 *   C. Deploy the locked rules + composite indexes from this repo:
 *        firebase login --reauth
 *        cd hub-next
 *        firebase deploy --only firestore:rules,firestore:indexes \
 *          --project fandf-dashboard
 *
 *   (gcloud equivalents, if ever available:
 *      gcloud services enable firestore.googleapis.com --project fandf-dashboard
 *      gcloud firestore databases create --project fandf-dashboard \
 *        --location me-west1 --type firestore-native
 *      gcloud projects add-iam-policy-binding fandf-dashboard \
 *        --member serviceAccount:dashboard-tasks-writer@fandf-dashboard.iam.gserviceaccount.com \
 *        --role roles/datastore.user )
 *
 *   No new Secret Manager entry is needed — Firestore reuses the
 *   existing TASKS_SA_KEY_JSON secret already wired in apphosting.yaml.
 */

import type { Firestore } from "@google-cloud/firestore";

/** Collection names — single source of truth for every phase. */
export const FS_COLLECTIONS = {
  /** doc id = the existing `T-…` task id (preserved so links / GT refs
   *  / cross-references keep working unchanged). */
  tasks: "tasks",
  /** doc id = the existing comment id (`c-…`). */
  comments: "comments",
  /** append-only ledger; doc id = Firestore autoId. */
  pricingLog: "pricingLog",
} as const;

type SAKey = {
  project_id: string;
  client_email: string;
  private_key: string;
};

function loadSAKey(): SAKey {
  const raw = process.env.TASKS_SA_KEY_JSON;
  if (!raw) {
    throw new Error(
      "TASKS_SA_KEY_JSON is not set — required for the Firestore admin client.",
    );
  }
  let parsed: SAKey;
  try {
    parsed = JSON.parse(raw) as SAKey;
  } catch (e) {
    throw new Error(
      `TASKS_SA_KEY_JSON is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
    throw new Error(
      "TASKS_SA_KEY_JSON is missing project_id / client_email / private_key.",
    );
  }
  return parsed;
}

let _db: Firestore | null = null;

/**
 * Lazily construct (once per process) and return the Firestore admin
 * client. Server-only. Throws if TASKS_SA_KEY_JSON is absent/invalid —
 * callers behind the USE_FIRESTORE_TASKS flag are responsible for not
 * reaching here until the flag is on and the infra (above) is in place.
 *
 * The database id defaults to "(default)". Override with
 * FIRESTORE_DATABASE_ID only if the owner creates a NAMED database
 * instead of the default one (the Phase-0 commands above create the
 * default).
 */
export function getDb(): Firestore {
  if (_db) return _db;
  const key = loadSAKey();
  // Lazy require so importing this module never pulls the gRPC client
  // into a bundle / triggers a connection. Mirrors how the rest of the
  // seam dynamically imports server-only deps.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Firestore } = require("@google-cloud/firestore") as typeof import("@google-cloud/firestore");
  _db = new Firestore({
    projectId: key.project_id,
    databaseId: process.env.FIRESTORE_DATABASE_ID || "(default)",
    credentials: {
      client_email: key.client_email,
      private_key: key.private_key,
    },
  });
  return _db;
}

/**
 * Re-exported from lib/sa.ts (canonical home, alongside the other
 * useSA* flags per the migration handoff) so Firestore code paths only
 * need this one import. Both default OFF.
 *   - useFirestoreDualWrite → Phase 2 mirror enable (turn on first)
 *   - useFirestoreTasks     → Phase 3 read cutover (flip after soak)
 */
export { useFirestoreDualWrite, useFirestoreTasks } from "@/lib/sa";
