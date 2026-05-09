/* eslint-disable */
/**
 * One-shot: seed `<shared>/סכמות משימה/` with department subfolders +
 * empty Google Doc placeholders matching every (department, kind)
 * pair on the TaskFormSchema sheet.
 *
 * After this runs, any (dept, kind) pair on /tasks/new will be
 * resolvable via lib/taskTemplates.ts → folder convention. Admins
 * can open each empty doc and type the template content; the
 * explicit `template_doc_id` column on the schema sheet stays
 * untouched (so any existing explicit bindings keep winning).
 *
 * Usage:
 *   node scripts/seed-template-folders.mjs            # dry-run
 *   node scripts/seed-template-folders.mjs --apply    # actually create
 *
 * Idempotent: re-runs only create what's missing. Never deletes,
 * never modifies existing files.
 *
 * Auth: SA + DWD impersonation of DRIVE_FOLDER_OWNER. Same scopes
 * the production pipeline uses.
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
const SCHEMA_SHEET_ID =
  process.env.SHEET_ID_COMMENTS || envFromFile("SHEET_ID_COMMENTS");
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
if (!SCHEMA_SHEET_ID) {
  console.error("Missing SHEET_ID_COMMENTS");
  process.exit(1);
}
if (!KEY_RAW) {
  console.error("Missing TASKS_SA_KEY_JSON");
  process.exit(1);
}

const k = JSON.parse(KEY_RAW);
// Two separate JWTs — DWD allowlist on this project is per-scope, so
// asking for both drive + sheets together fails even though each one
// works individually. Mirrors the pattern the rest of scripts/ uses.
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

const TEMPLATES_ROOT_NAME = "סכמות משימה";
const SCHEMA_TAB = "TaskFormSchema";

console.log(
  `[seed-template-folders] mode=${APPLY ? "APPLY" : "dry-run"} subject=${SUBJECT}`,
);

async function findChildFolder(parentId, name) {
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
  return res.data.files?.[0]?.id || null;
}

async function findChildFile(parentId, name) {
  const safe = name.replace(/'/g, "\\'");
  // Match by name across any non-folder mime type — admin might have
  // already dropped a Google Doc / Sheet / Slides / DOCX with the
  // kind name, in which case we leave it alone.
  const res = await drive.files.list({
    q: [
      "mimeType!='application/vnd.google-apps.folder'",
      `name='${safe}'`,
      `'${parentId}' in parents`,
      "trashed=false",
    ].join(" and "),
    fields: "files(id, name, mimeType)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "drive",
    driveId: SHARED_DRIVE_ID,
  });
  return res.data.files?.[0] || null;
}

async function createFolder(parentId, name) {
  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id, name",
    supportsAllDrives: true,
  });
  return created.data;
}

async function createGoogleDoc(parentId, name) {
  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.document",
      parents: [parentId],
    },
    fields: "id, name",
    supportsAllDrives: true,
  });
  return created.data;
}

async function readSchemaPairs() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SCHEMA_SHEET_ID,
    range: SCHEMA_TAB,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const values = res.data.values || [];
  if (values.length < 2) return [];
  const headers = (values[0] || []).map((h) => String(h ?? "").trim());
  const iDept = headers.findIndex(
    (h) => h === "מחלקה" || h.toLowerCase() === "department",
  );
  const iKind = headers.findIndex(
    (h) => h === "סוג" || h.toLowerCase() === "kind",
  );
  if (iDept < 0 || iKind < 0) {
    throw new Error(
      `TaskFormSchema headers missing מחלקה/סוג; got ${JSON.stringify(headers)}`,
    );
  }
  const seen = new Set();
  const pairs = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r] || [];
    const dept = String(row[iDept] ?? "").trim();
    const kind = String(row[iKind] ?? "").trim();
    if (!dept || !kind) continue;
    const key = `${dept}|${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ dept, kind });
  }
  return pairs;
}

async function main() {
  // 1. Find the existing סכמות משימה folder. Reject if missing — the
  //    user said they created it, so a missing folder is operator
  //    error (wrong shared drive, typo in the name, etc.).
  const rootId = await findChildFolder(SHARED_DRIVE_ID, TEMPLATES_ROOT_NAME);
  if (!rootId) {
    console.error(
      `Couldn't find folder named "${TEMPLATES_ROOT_NAME}" at the root of the shared drive ${SHARED_DRIVE_ID}.`,
    );
    console.error(
      `Please create it (e.g. via Drive UI), then re-run this script.`,
    );
    process.exit(2);
  }
  console.log(`Found "${TEMPLATES_ROOT_NAME}" → ${rootId}`);

  // 2. Read the schema sheet for (dept, kind) pairs.
  const pairs = await readSchemaPairs();
  if (pairs.length === 0) {
    console.log("Schema is empty; nothing to seed.");
    return;
  }
  // Group by dept for stable per-dept logging.
  const byDept = new Map();
  for (const { dept, kind } of pairs) {
    const list = byDept.get(dept) || [];
    list.push(kind);
    byDept.set(dept, list);
  }
  const deptNames = Array.from(byDept.keys()).sort((a, b) =>
    a.localeCompare(b, "he"),
  );
  console.log(
    `Schema has ${deptNames.length} departments, ${pairs.length} kinds total.`,
  );

  let foldersCreated = 0;
  let foldersFound = 0;
  let docsCreated = 0;
  let docsFound = 0;

  for (const dept of deptNames) {
    let deptFolderId = await findChildFolder(rootId, dept);
    if (deptFolderId) {
      foldersFound++;
      console.log(`  [exists] ${dept}/`);
    } else {
      if (APPLY) {
        const created = await createFolder(rootId, dept);
        deptFolderId = created.id;
        foldersCreated++;
        console.log(`  [+folder] ${dept}/`);
      } else {
        console.log(`  [+folder] ${dept}/   (dry-run)`);
        foldersCreated++; // for counting
      }
    }
    const kinds = byDept.get(dept);
    for (const kind of kinds) {
      // In dry-run mode without a folder id, skip the file probe — we
      // can't list children of a folder that doesn't exist yet. Just
      // assume we'd create the doc.
      if (!deptFolderId) {
        docsCreated++;
        console.log(`    [+doc]    ${dept}/${kind}   (dry-run, parent pending)`);
        continue;
      }
      const existing = await findChildFile(deptFolderId, kind);
      if (existing) {
        docsFound++;
        console.log(
          `    [exists]  ${dept}/${kind}   (${existing.mimeType?.split(".").pop()})`,
        );
        continue;
      }
      if (APPLY) {
        await createGoogleDoc(deptFolderId, kind);
        docsCreated++;
        console.log(`    [+doc]    ${dept}/${kind}`);
      } else {
        docsCreated++;
        console.log(`    [+doc]    ${dept}/${kind}   (dry-run)`);
      }
    }
  }

  console.log("");
  console.log(`Summary:`);
  console.log(
    `  folders: ${foldersFound} existed, ${foldersCreated} ${APPLY ? "created" : "would create"}`,
  );
  console.log(
    `  docs:    ${docsFound} existed, ${docsCreated} ${APPLY ? "created" : "would create"}`,
  );
  if (!APPLY && (foldersCreated > 0 || docsCreated > 0)) {
    console.log("");
    console.log("Re-run with --apply to actually create the items above.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
