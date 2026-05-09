/* eslint-disable */
/**
 * One-shot migration: convert each existing template doc at
 * `<shared>/סכמות משימה/<Dept>/<Kind>.gdoc` into a folder of the
 * same name, with the original doc moved INSIDE the new folder.
 *
 * Before:
 *   סכמות משימה/Media/הכנת פריסה.gdoc      (file)
 *
 * After:
 *   סכמות משימה/Media/הכנת פריסה/         (folder)
 *     הכנת פריסה.gdoc                    (file moved into folder)
 *
 * The new folder is the source of truth for the resolver going
 * forward (see lib/taskTemplates.ts post-2026-05-09). Multiple
 * template variants can be dropped into the same kind folder.
 *
 * Idempotent: re-runs find no per-dept files to migrate. Safe to
 * --apply repeatedly.
 *
 * Schema sheet is NOT touched. After running this, run the regular
 * Drive → Sheet sync to rebind template_doc_id to the new folder
 * ids (either via the "🔄 סנכרן מ-Drive" button on /admin/task-form-
 * schema or by calling /api/admin/sync-task-form-schema directly).
 *
 * Usage:
 *   node scripts/migrate-template-kinds-to-folders.mjs            # dry-run
 *   node scripts/migrate-template-kinds-to-folders.mjs --apply    # actually migrate
 *
 * Auth: SA + DWD impersonation of DRIVE_FOLDER_OWNER.
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

const TEMPLATES_ROOT_NAME = "סכמות משימה";
const DRIVE_EXTENSION_RE = /\.(gdoc|gsheet|gslides|docx|xlsx|pptx)$/i;

console.log(
  `[migrate-template-kinds-to-folders] mode=${APPLY ? "APPLY" : "dry-run"} subject=${SUBJECT}`,
);

async function findChild(parentId, name, asFolder = true) {
  const safe = name.replace(/'/g, "\\'");
  const mimeFilter = asFolder
    ? "mimeType='application/vnd.google-apps.folder'"
    : "mimeType!='application/vnd.google-apps.folder'";
  const res = await drive.files.list({
    q: [
      mimeFilter,
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

async function listChildren(parentId, asFolder) {
  const items = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: [
        asFolder
          ? "mimeType='application/vnd.google-apps.folder'"
          : "mimeType!='application/vnd.google-apps.folder'",
        `'${parentId}' in parents`,
        "trashed=false",
      ].join(" and "),
      fields: "nextPageToken, files(id, name, mimeType, parents)",
      pageSize: 200,
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

async function moveFile(fileId, fromParentId, toParentId) {
  return drive.files.update({
    fileId,
    addParents: toParentId,
    removeParents: fromParentId,
    fields: "id, parents",
    supportsAllDrives: true,
  });
}

function strip(name) {
  return String(name || "").trim().replace(DRIVE_EXTENSION_RE, "");
}

async function main() {
  const root = await findChild(SHARED_DRIVE_ID, TEMPLATES_ROOT_NAME, true);
  if (!root) {
    console.error(
      `Couldn't find folder named "${TEMPLATES_ROOT_NAME}" — nothing to migrate.`,
    );
    process.exit(2);
  }
  console.log(`Found "${TEMPLATES_ROOT_NAME}" → ${root.id}`);

  const depts = await listChildren(root.id, true);
  console.log(`Scanning ${depts.length} department folders…`);

  let folderCreated = 0;
  let folderExisted = 0;
  let docMoved = 0;
  let docAlreadyInFolder = 0;
  let errors = 0;

  for (const dept of depts) {
    if (!dept.id || !dept.name) continue;
    // Files that live DIRECTLY under the dept folder = legacy docs.
    const legacyFiles = await listChildren(dept.id, false);
    if (legacyFiles.length === 0) {
      // Already migrated (or this dept was added post-restructure).
      // Check if there are any kind sub-folders already so the log
      // reads correctly.
      const kindFolders = await listChildren(dept.id, true);
      if (kindFolders.length === 0) {
        console.log(`  ${dept.name}/   (empty)`);
      } else {
        console.log(
          `  ${dept.name}/   (${kindFolders.length} kind folders, no legacy files)`,
        );
      }
      continue;
    }
    console.log(
      `  ${dept.name}/   (${legacyFiles.length} legacy files to migrate)`,
    );

    for (const f of legacyFiles) {
      if (!f.id || !f.name) continue;
      const kindName = strip(f.name);
      if (!kindName) continue;

      // Step 1: ensure kind sub-folder exists.
      let kindFolder = await findChild(dept.id, kindName, true);
      if (kindFolder) {
        folderExisted++;
      } else {
        if (APPLY) {
          kindFolder = await createFolder(dept.id, kindName);
          folderCreated++;
          console.log(`    [+folder] ${dept.name}/${kindName}/`);
        } else {
          folderCreated++;
          console.log(`    [+folder] ${dept.name}/${kindName}/   (dry-run)`);
        }
      }

      // Step 2: move the legacy file INTO the kind folder.
      // If the file is already inside (idempotent re-run), skip.
      const currentParent = (f.parents || [])[0];
      if (kindFolder && currentParent === kindFolder.id) {
        docAlreadyInFolder++;
        continue;
      }
      if (!kindFolder) {
        // Dry-run + folder doesn't exist yet — assume the move
        // would work and count it. The actual --apply pass creates
        // the folder first, so this branch is dry-run-only.
        docMoved++;
        console.log(
          `    [+move]   ${dept.name}/${f.name} → ${dept.name}/${kindName}/${f.name}   (dry-run)`,
        );
        continue;
      }
      if (APPLY) {
        try {
          await moveFile(f.id, dept.id, kindFolder.id);
          docMoved++;
          console.log(
            `    [+move]   ${dept.name}/${f.name} → ${dept.name}/${kindName}/${f.name}`,
          );
        } catch (e) {
          errors++;
          console.warn(
            `    [error]   moving ${f.name}: ${e.message || e}`,
          );
        }
      } else {
        docMoved++;
        console.log(
          `    [+move]   ${dept.name}/${f.name} → ${dept.name}/${kindName}/${f.name}   (dry-run)`,
        );
      }
    }
  }

  console.log("");
  console.log(`Summary:`);
  console.log(
    `  kind folders: ${folderExisted} existed, ${folderCreated} ${
      APPLY ? "created" : "would create"
    }`,
  );
  console.log(
    `  doc moves:    ${docAlreadyInFolder} already nested, ${docMoved} ${
      APPLY ? "moved" : "would move"
    }`,
  );
  if (errors) console.log(`  errors: ${errors}`);
  if (!APPLY && (folderCreated > 0 || docMoved > 0)) {
    console.log("");
    console.log("Re-run with --apply to actually do the work above.");
    console.log(
      "After --apply, run the Drive→Sheet sync (manual button or cron) so the schema sheet rebinds template_doc_id to the new folder ids.",
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
