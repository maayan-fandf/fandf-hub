/* eslint-disable */
/**
 * Local-runnable variant of /api/cron/cleanup-task-drafts. Walks
 * `_drafts_/<*>/<*>` on the F&F Tasks Shared Drive and trashes draft
 * folders older than the configured TTL.
 *
 * Usage:
 *   node scripts/cleanup-task-drafts.mjs                  # dry-run, 24h TTL
 *   node scripts/cleanup-task-drafts.mjs --apply          # actually delete
 *   node scripts/cleanup-task-drafts.mjs --ttl-hours=12   # custom cutoff
 *   node scripts/cleanup-task-drafts.mjs --apply --ttl-hours=72
 *
 * Drive auth: SA + DWD impersonation of DRIVE_FOLDER_OWNER (default
 * maayan@fandf.co.il). Same scope as the production cron.
 *
 * Safety:
 *   - Default is dry-run; `--apply` is required to actually delete.
 *   - Cutoff defaults to 24h; never deletes anything younger.
 *   - Drive `modifiedTime` AND `createdTime` are both consulted; the
 *     LATER wins. (A freshly-copied template has createdTime≈now but
 *     modifiedTime preserved from the source; we want createdTime to
 *     be the floor for "abandoned" decisions.)
 */
import { google } from "googleapis";
import fs from "node:fs";

const APPLY = process.argv.includes("--apply");
const ttlArg = process.argv.find((a) => a.startsWith("--ttl-hours="));
const TTL_HOURS = ttlArg
  ? Math.max(1, Math.min(24 * 30, Number(ttlArg.replace("--ttl-hours=", ""))))
  : 24;

const envText = fs.existsSync(".env.local")
  ? fs.readFileSync(".env.local", "utf8")
  : "";
function envFromFile(name) {
  const line = envText.split("\n").find((l) => l.startsWith(name + "="));
  return line ? line.replace(/^[^=]+=/, "") : "";
}

const SHARED_DRIVE_ID =
  process.env.TASKS_SHARED_DRIVE_ID || envFromFile("TASKS_SHARED_DRIVE_ID");
const KEY_RAW =
  process.env.TASKS_SA_KEY_JSON || envFromFile("TASKS_SA_KEY_JSON");
const SUBJECT =
  process.env.DRIVE_FOLDER_OWNER ||
  envFromFile("DRIVE_FOLDER_OWNER") ||
  "maayan@fandf.co.il";

if (!SHARED_DRIVE_ID) {
  console.error("Missing TASKS_SHARED_DRIVE_ID");
  process.exit(1);
}
if (!KEY_RAW) {
  console.error("Missing TASKS_SA_KEY_JSON");
  process.exit(1);
}

const k = JSON.parse(KEY_RAW);
const auth = new google.auth.JWT({
  email: k.client_email,
  key: k.private_key,
  scopes: ["https://www.googleapis.com/auth/drive"],
  subject: SUBJECT,
});
const drive = google.drive({ version: "v3", auth });

const DRAFTS_ROOT_NAME = "_drafts_";
const cutoffMs = Date.now() - TTL_HOURS * 60 * 60 * 1000;

console.log(
  `[cleanup-task-drafts] mode=${APPLY ? "APPLY" : "dry-run"} ttl=${TTL_HOURS}h cutoff=${new Date(
    cutoffMs,
  ).toISOString()}`,
);

async function findChild(parentId, name) {
  const safe = name.replace(/'/g, "\\'");
  const q = [
    "mimeType='application/vnd.google-apps.folder'",
    `name='${safe}'`,
    `'${parentId}' in parents`,
    "trashed=false",
  ].join(" and ");
  const res = await drive.files.list({
    q,
    fields: "files(id, name)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "drive",
    driveId: SHARED_DRIVE_ID,
  });
  return res.data.files?.[0]?.id ?? null;
}

async function listChildFolders(parentId, pageSize = 200) {
  const items = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: [
        "mimeType='application/vnd.google-apps.folder'",
        `'${parentId}' in parents`,
        "trashed=false",
      ].join(" and "),
      fields:
        "nextPageToken, files(id, name, modifiedTime, createdTime)",
      pageSize,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: "drive",
      driveId: SHARED_DRIVE_ID,
    });
    items.push(...(res.data.files ?? []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return items;
}

async function main() {
  const draftsRootId = await findChild(SHARED_DRIVE_ID, DRAFTS_ROOT_NAME);
  if (!draftsRootId) {
    console.log("No _drafts_ folder yet — nothing to do.");
    return;
  }
  const buckets = await listChildFolders(draftsRootId);
  console.log(`Scanning ${buckets.length} per-user buckets…`);

  let scanned = 0;
  let deleted = 0;
  let kept = 0;
  let errored = 0;

  for (const bucket of buckets) {
    const drafts = await listChildFolders(bucket.id);
    for (const d of drafts) {
      scanned++;
      const modMs = Date.parse(d.modifiedTime || "");
      const ctMs = Date.parse(d.createdTime || "");
      const lastTouchedMs = Math.max(
        Number.isFinite(modMs) ? modMs : 0,
        Number.isFinite(ctMs) ? ctMs : 0,
      );
      if (lastTouchedMs === 0 || lastTouchedMs > cutoffMs) {
        kept++;
        continue;
      }
      const ageHours = (
        (Date.now() - lastTouchedMs) /
        (60 * 60 * 1000)
      ).toFixed(1);
      const action = APPLY ? "DELETE" : "[dry-run] would delete";
      console.log(
        `${action}  bucket=${bucket.name}  draft=${d.name}  age=${ageHours}h`,
      );
      if (APPLY) {
        try {
          await drive.files.delete({
            fileId: d.id,
            supportsAllDrives: true,
          });
          deleted++;
        } catch (e) {
          errored++;
          console.warn(`  failed: ${e.message || e}`);
        }
      } else {
        deleted++; // for the summary
      }
    }
  }

  console.log(
    `\nScanned: ${scanned}   ${APPLY ? "Deleted" : "Would delete"}: ${deleted}   Kept: ${kept}   Errors: ${errored}`,
  );
  if (!APPLY && deleted > 0) {
    console.log("Re-run with --apply to actually delete.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
