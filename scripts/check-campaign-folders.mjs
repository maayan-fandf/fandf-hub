/* eslint-disable */
// Mirror listCampaignFolders + the campaigns-API merge to figure out
// why a Drive folder doesn't appear in the campaign dropdown.
// Run: node scripts/check-campaign-folders.mjs "<company>" "<project>" [<subject>]
import { google } from "googleapis";
import fs from "node:fs";

const COMPANY = process.argv[2] || "גיא ודורון";
const PROJECT = process.argv[3] || "אורנבך ראשון לציון";
const SUBJECT = process.argv[4] || "maayan@fandf.co.il";

const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
const env = (n) => process.env[n] || (envText.split("\n").find((l) => l.startsWith(n + "=")) || "").replace(/^[^=]+=/, "");

const k = JSON.parse(env("TASKS_SA_KEY_JSON"));
const subject = env("DRIVE_FOLDER_OWNER") || SUBJECT;
console.log(`Subject (impersonated): ${subject}`);
console.log(`Looking for: ${COMPANY} > ${PROJECT}\n`);

const auth = new google.auth.JWT({
  email: k.client_email, key: k.private_key,
  scopes: ["https://www.googleapis.com/auth/drive"],
  subject,
});
const drive = google.drive({ version: "v3", auth });
const sharedDriveId = env("TASKS_SHARED_DRIVE_ID");
console.log(`Shared Drive ID: ${sharedDriveId || "(not set)"}\n`);

async function findChildFolder(parentId, name) {
  const res = await drive.files.list({
    q: [
      "mimeType='application/vnd.google-apps.folder'",
      `'${parentId}' in parents`,
      `name='${name.replace(/'/g, "\\'")}'`,
      "trashed=false",
    ].join(" and "),
    fields: "files(id, name)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "drive",
    driveId: sharedDriveId,
  });
  return res.data.files?.[0] ?? null;
}

const company = await findChildFolder(sharedDriveId, COMPANY);
console.log(`Company folder: ${company ? `${company.id}` : "(not found)"}`);
if (!company) process.exit(1);

const project = await findChildFolder(company.id, PROJECT);
console.log(`Project folder: ${project ? `${project.id}` : "(not found)"}`);
if (!project) process.exit(1);

console.log(`\nListing all sub-folders of project root:\n`);
const sub = await drive.files.list({
  q: [
    "mimeType='application/vnd.google-apps.folder'",
    `'${project.id}' in parents`,
    "trashed=false",
  ].join(" and "),
  fields: "files(id, name, modifiedTime)",
  orderBy: "modifiedTime desc",
  pageSize: 200,
  supportsAllDrives: true,
  includeItemsFromAllDrives: true,
  corpora: "drive",
  driveId: sharedDriveId,
});
const files = sub.data.files ?? [];
console.log(`Found ${files.length} sub-folders.\n`);

const SHARED_SUFFIX = "תיקיה משותפת";
function isSharedFolderName(name) {
  const trimmed = (name || "").trim();
  if (!trimmed.endsWith(` ${SHARED_SUFFIX}`)) return false;
  return trimmed.length > SHARED_SUFFIX.length + 1;
}

for (const f of files) {
  const filtered = isSharedFolderName(f.name);
  console.log(`  ${filtered ? "🚫" : "✅"} "${f.name}"  id=${f.id}  modified=${f.modifiedTime?.slice(0, 10)}`);
}

const wouldShow = files.filter(f => !isSharedFolderName(f.name)).map(f => f.name);
console.log(`\nWould appear in campaign dropdown: ${wouldShow.length}`);
wouldShow.forEach(n => console.log(`  • ${n}`));
