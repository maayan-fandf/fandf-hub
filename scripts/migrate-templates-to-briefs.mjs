/* eslint-disable */
/**
 * One-shot migration — rename + relocate every `(טיוטה)` template
 * file currently sitting at the root of a task's Drive folder into
 * the new canonical layout:
 *
 *   <task folder>/בריפים/<canonical-brief-name>
 *
 * Where <canonical-brief-name> follows the format chosen 2026-05-09:
 *
 *   <company> - <project> - <campaign> - <title> - <templateName> - <taskId>
 *
 * For each file, the script picks the OWNING task by minimum |task.created_at
 * - file.createdTime|. The most-recent task whose drive_folder_id matches
 * the file's parent wins on ties. Cancelled / done tasks still count —
 * they had templates too.
 *
 * Usage:
 *   node scripts/migrate-templates-to-briefs.mjs            # dry-run
 *   node scripts/migrate-templates-to-briefs.mjs --apply    # actually move
 *
 * Idempotent: re-runs find no `(טיוטה)` files at the root (they're
 * all under בריפים now) so subsequent runs are no-ops. Files
 * already inside a בריפים folder are skipped.
 */
import { google } from "googleapis";
import fs from "node:fs";

const APPLY = process.argv.includes("--apply");

const envText = fs.existsSync(".env.local")
  ? fs.readFileSync(".env.local", "utf8")
  : "";
function envFromFile(name) {
  const line = envText.split("\n").find((l) => l.startsWith(name + "="));
  return line ? line.replace(/^[^=]+=/, "") : "";
}

const SHARED_DRIVE_ID =
  process.env.TASKS_SHARED_DRIVE_ID || envFromFile("TASKS_SHARED_DRIVE_ID");
const SHEET_ID_COMMENTS =
  process.env.SHEET_ID_COMMENTS || envFromFile("SHEET_ID_COMMENTS");
const KEY_RAW =
  process.env.TASKS_SA_KEY_JSON || envFromFile("TASKS_SA_KEY_JSON");
const SUBJECT =
  process.env.DRIVE_FOLDER_OWNER ||
  envFromFile("DRIVE_FOLDER_OWNER") ||
  "maayan@fandf.co.il";

if (!SHARED_DRIVE_ID || !SHEET_ID_COMMENTS || !KEY_RAW) {
  console.error("Missing TASKS_SHARED_DRIVE_ID / SHEET_ID_COMMENTS / TASKS_SA_KEY_JSON");
  process.exit(1);
}

const k = JSON.parse(KEY_RAW);
const driveAuth = new google.auth.JWT({
  email: k.client_email,
  key: k.private_key,
  scopes: ["https://www.googleapis.com/auth/drive"],
  subject: SUBJECT,
});
const sheetsAuth = new google.auth.JWT({
  email: k.client_email,
  key: k.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  subject: SUBJECT,
});
const drive = google.drive({ version: "v3", auth: driveAuth });
const sheets = google.sheets({ version: "v4", auth: sheetsAuth });

const TASKS_TAB = "Comments";
const BRIEFS_NAME = "בריפים";
const TIYUTA_RE = /\s*\(טיוטה\)\s*$/;

console.log(`mode=${APPLY ? "APPLY" : "dry-run"} subject=${SUBJECT}`);

function buildBriefName(t, originalName) {
  const templateName = String(originalName || "").replace(TIYUTA_RE, "").trim();
  const parts = [
    t.company,
    t.project,
    t.campaign || "",
    t.title,
    templateName,
    t.id,
  ]
    .map((s) => String(s || "").trim().replace(/[\\/]/g, "-"))
    .filter(Boolean);
  return parts.join(" - ");
}

async function readAllTasks() {
  // The Comments tab has a wide schema; we only need a few cols.
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID_COMMENTS,
    range: TASKS_TAB,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const values = res.data.values || [];
  if (values.length < 2) return [];
  const headers = values[0].map((h) => String(h ?? "").trim());
  const idx = (name) => headers.findIndex((h) => h === name);
  const iId = idx("id");
  // The Comments sheet stores the row creation time in `timestamp`,
  // not `created_at`. (`created_at` is the typed surface in
  // WorkTask but doesn't map to a column on this sheet.)
  const iTimestamp = idx("timestamp");
  const iCompany = idx("company");
  const iProject = idx("project");
  const iCampaign = idx("campaign");
  const iTitle = idx("title");
  const iDriveFolderId = idx("drive_folder_id");
  if (iId < 0 || iDriveFolderId < 0) {
    throw new Error(
      `Tasks sheet missing required columns. headers=${headers.join("|")}`,
    );
  }
  const tasks = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r] || [];
    const id = String(row[iId] || "").trim();
    const driveFolderId = String(row[iDriveFolderId] || "").trim();
    if (!id || !driveFolderId) continue;
    tasks.push({
      id,
      created_at: String(row[iTimestamp] || ""),
      company: String(row[iCompany] || ""),
      project: String(row[iProject] || ""),
      campaign: String(row[iCampaign] || ""),
      title: String(row[iTitle] || ""),
      drive_folder_id: driveFolderId,
    });
  }
  return tasks;
}

async function listFolderChildren(folderId, mimeFilter) {
  const items = [];
  let pageToken;
  do {
    const q = [
      mimeFilter ? mimeFilter : "",
      `'${folderId}' in parents`,
      "trashed=false",
    ]
      .filter(Boolean)
      .join(" and ");
    const res = await drive.files.list({
      q,
      fields:
        "nextPageToken, files(id, name, mimeType, parents, createdTime)",
      pageSize: 200,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: "drive",
      driveId: SHARED_DRIVE_ID,
    });
    items.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return items;
}

async function getOrCreateBriefsFolder(parentId) {
  const existing = await listFolderChildren(
    parentId,
    "mimeType='application/vnd.google-apps.folder'",
  );
  const found = existing.find((f) => f.name === BRIEFS_NAME);
  if (found) return found.id;
  const created = await drive.files.create({
    requestBody: {
      name: BRIEFS_NAME,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id",
    supportsAllDrives: true,
  });
  if (!created.data.id) throw new Error("create בריפים failed");
  return created.data.id;
}

function pickOwningTask(file, candidates) {
  // Closest task by created_at; tiebreak by most-recently-created.
  const fileTime = Date.parse(file.createdTime || "") || 0;
  let best = null;
  let bestDelta = Infinity;
  for (const t of candidates) {
    const taskTime = Date.parse(t.created_at) || 0;
    const delta = Math.abs(taskTime - fileTime);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = t;
    }
  }
  return best;
}

async function main() {
  const tasks = await readAllTasks();
  console.log(`tasks with drive_folder_id: ${tasks.length}`);

  // Group tasks by drive_folder_id (campaign folders are shared).
  const tasksByFolderId = new Map();
  for (const t of tasks) {
    const list = tasksByFolderId.get(t.drive_folder_id) || [];
    list.push(t);
    tasksByFolderId.set(t.drive_folder_id, list);
  }

  let candidatesFound = 0;
  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  for (const [folderId, folderTasks] of tasksByFolderId) {
    let children;
    try {
      children = await listFolderChildren(
        folderId,
        "mimeType!='application/vnd.google-apps.folder'",
      );
    } catch (e) {
      console.warn(`  list folder ${folderId} failed: ${e.message || e}`);
      errors++;
      continue;
    }
    const drafts = children.filter((f) => TIYUTA_RE.test(f.name || ""));
    if (drafts.length === 0) continue;

    candidatesFound += drafts.length;
    let briefsFolderId = null;

    for (const file of drafts) {
      const owningTask = pickOwningTask(file, folderTasks);
      if (!owningTask) {
        console.warn(
          `  no owning task for ${file.name} (id=${file.id}, parent=${folderId})`,
        );
        skipped++;
        continue;
      }
      const newName = buildBriefName(owningTask, file.name || "");
      console.log(
        `  ${file.name}  →  בריפים/${newName}  (task=${owningTask.id})`,
      );
      if (!APPLY) {
        migrated++;
        continue;
      }
      try {
        if (!briefsFolderId) {
          briefsFolderId = await getOrCreateBriefsFolder(folderId);
        }
        await drive.files.update({
          fileId: file.id,
          requestBody: { name: newName },
          addParents: briefsFolderId,
          removeParents: (file.parents || []).join(","),
          fields: "id",
          supportsAllDrives: true,
        });
        migrated++;
      } catch (e) {
        console.warn(`    [error] ${e.message || e}`);
        errors++;
      }
    }
  }

  console.log("");
  console.log(`Summary:`);
  console.log(`  candidate (טיוטה) files: ${candidatesFound}`);
  console.log(
    `  ${APPLY ? "migrated" : "would migrate"}: ${migrated}`,
  );
  console.log(`  skipped (no owning task): ${skipped}`);
  if (errors) console.log(`  errors: ${errors}`);
  if (!APPLY && migrated > 0) {
    console.log("\nRe-run with --apply to actually rename + move.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
