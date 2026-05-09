/* eslint-disable */
/**
 * One-shot cleanup — deletes everything inside _drafts_/<userEmail>/.
 * Used to reap orphans from before the inline-template fix landed
 * (b65d520).
 *
 *   node scripts/cleanup-orphan-drafts.mjs            # dry-run
 *   node scripts/cleanup-orphan-drafts.mjs --apply    # delete
 */
import { google } from "googleapis";
import fs from "node:fs";

const APPLY = process.argv.includes("--apply");
const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
function envFromFile(name) { const line = envText.split("\n").find((l) => l.startsWith(name + "=")); return line ? line.replace(/^[^=]+=/, "") : ""; }

const SHARED_DRIVE_ID = process.env.TASKS_SHARED_DRIVE_ID || envFromFile("TASKS_SHARED_DRIVE_ID");
const KEY_RAW = process.env.TASKS_SA_KEY_JSON || envFromFile("TASKS_SA_KEY_JSON");
const SUBJECT = process.env.DRIVE_FOLDER_OWNER || envFromFile("DRIVE_FOLDER_OWNER") || "maayan@fandf.co.il";
const k = JSON.parse(KEY_RAW);
const auth = new google.auth.JWT({ email: k.client_email, key: k.private_key, scopes: ["https://www.googleapis.com/auth/drive"], subject: SUBJECT });
const drive = google.drive({ version: "v3", auth });

async function findChild(parentId, name) {
  const safe = name.replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: ["mimeType='application/vnd.google-apps.folder'", `name='${safe}'`, `'${parentId}' in parents`, "trashed=false"].join(" and "),
    fields: "files(id, name)", pageSize: 1, supportsAllDrives: true, includeItemsFromAllDrives: true, corpora: "drive", driveId: SHARED_DRIVE_ID,
  });
  return res.data.files?.[0] || null;
}
async function listChildren(parentId) {
  const items = []; let pageToken;
  do {
    const res = await drive.files.list({
      q: [`'${parentId}' in parents`, "trashed=false"].join(" and "),
      fields: "nextPageToken, files(id, name, modifiedTime)", pageSize: 200, pageToken,
      supportsAllDrives: true, includeItemsFromAllDrives: true, corpora: "drive", driveId: SHARED_DRIVE_ID,
    });
    items.push(...(res.data.files || [])); pageToken = res.data.nextPageToken;
  } while (pageToken);
  return items;
}

console.log(`mode=${APPLY ? "APPLY" : "dry-run"} subject=${SUBJECT}`);
const draftsRoot = await findChild(SHARED_DRIVE_ID, "_drafts_");
if (!draftsRoot) { console.log("no _drafts_ folder"); process.exit(0); }
const userBuckets = await listChildren(draftsRoot.id);
let total = 0;
for (const bucket of userBuckets) {
  const drafts = await listChildren(bucket.id);
  console.log(`${bucket.name}/ — ${drafts.length} drafts`);
  for (const d of drafts) {
    console.log(`  - ${d.name} (${d.id}) modified=${d.modifiedTime}`);
    total++;
    if (APPLY) {
      try { await drive.files.delete({ fileId: d.id, supportsAllDrives: true }); console.log(`      [deleted]`); }
      catch (e) { console.log(`      [error] ${e.message || e}`); }
    }
  }
}
console.log(`\n${APPLY ? "Deleted" : "Would delete"} ${total} draft folders.`);
