/* eslint-disable */
/**
 * Diagnostic — list contents of a Drive folder + show parent path.
 * Used to debug template-adoption issues where the form claims a
 * draft was made but the file isn't where we expect.
 *
 * Usage:
 *   node scripts/probe-task-folder.mjs <folder-id>
 *   node scripts/probe-task-folder.mjs --drafts   # list everything under _drafts_
 */
import { google } from "googleapis";
import fs from "node:fs";

const arg = process.argv[2];
if (!arg) {
  console.error("usage: node scripts/probe-task-folder.mjs <folder-id> | --drafts");
  process.exit(1);
}

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

const k = JSON.parse(KEY_RAW);
const auth = new google.auth.JWT({
  email: k.client_email,
  key: k.private_key,
  scopes: ["https://www.googleapis.com/auth/drive"],
  subject: SUBJECT,
});
const drive = google.drive({ version: "v3", auth });

async function listChildren(parentId) {
  const items = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: [`'${parentId}' in parents`, "trashed=false"].join(" and "),
      fields: "nextPageToken, files(id, name, mimeType, modifiedTime, parents)",
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

async function getMeta(fileId) {
  const res = await drive.files.get({
    fileId,
    fields: "id, name, mimeType, parents, webViewLink, modifiedTime",
    supportsAllDrives: true,
  });
  return res.data;
}

async function findChild(parentId, name) {
  const safe = name.replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: [
      "mimeType='application/vnd.google-apps.folder'",
      `name='${safe}'`,
      `'${parentId}' in parents`,
      "trashed=false",
    ].join(" and "),
    fields: "files(id, name)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "drive",
    driveId: SHARED_DRIVE_ID,
  });
  return res.data.files?.[0] || null;
}

async function dumpDraftsTree() {
  const draftsRoot = await findChild(SHARED_DRIVE_ID, "_drafts_");
  if (!draftsRoot) {
    console.log("(no _drafts_ folder found)");
    return;
  }
  console.log(`_drafts_ (${draftsRoot.id})`);
  const userBuckets = await listChildren(draftsRoot.id);
  for (const bucket of userBuckets) {
    console.log(`  ${bucket.name}/ (${bucket.id})`);
    const drafts = await listChildren(bucket.id);
    for (const d of drafts) {
      console.log(`    ${d.name} (${d.id}, ${d.mimeType}) modifiedTime=${d.modifiedTime}`);
      if (d.mimeType === "application/vnd.google-apps.folder") {
        const inside = await listChildren(d.id);
        for (const f of inside) {
          console.log(`      └ ${f.name} (${f.id}, ${f.mimeType})`);
        }
      }
    }
  }
}

async function main() {
  if (arg === "--drafts") {
    await dumpDraftsTree();
    return;
  }
  const meta = await getMeta(arg).catch((e) => {
    console.error(`getMeta(${arg}) failed: ${e.message}`);
    return null;
  });
  if (!meta) return;
  console.log(`folder: ${meta.name} (${meta.id}) — mime=${meta.mimeType}`);
  console.log(`webViewLink: ${meta.webViewLink || "(none)"}`);
  console.log(`parents: ${(meta.parents || []).join(", ")}`);
  console.log("");
  console.log("contents:");
  const items = await listChildren(arg);
  if (items.length === 0) {
    console.log("  (empty)");
    return;
  }
  for (const f of items) {
    console.log(`  ${f.name}    (${f.id}, mime=${f.mimeType}, modified=${f.modifiedTime})`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
