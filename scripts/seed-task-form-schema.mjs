/* eslint-disable */
// Create the "TaskFormSchema" tab on the Comments spreadsheet and seed
// it with a cartesian product of (current departments × current kinds).
// The hub reads this sheet to populate /tasks/new's dropdowns; admins
// edit the sheet (or the upcoming /admin/task-form-schema page) to
// add/remove kinds per department.
//
//   node scripts/seed-task-form-schema.mjs              # dry-run
//   node scripts/seed-task-form-schema.mjs --commit     # create + seed
//
// Idempotent — if the tab already exists with rows, no-op (caller can
// re-run after pruning). To force a re-seed: delete the tab manually.
import { google } from "googleapis";
import fs from "node:fs";

const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
function envFromFile(name) {
  const line = envText.split("\n").find((l) => l.startsWith(name + "="));
  return line ? line.replace(/^[^=]+=/, "") : "";
}
const SHEET_ID_COMMENTS = process.env.SHEET_ID_COMMENTS || envFromFile("SHEET_ID_COMMENTS");
const k = JSON.parse(process.env.TASKS_SA_KEY_JSON || envFromFile("TASKS_SA_KEY_JSON"));
const COMMIT = process.argv.includes("--commit");
const SUBJECT = "maayan@fandf.co.il";

const TAB = "TaskFormSchema";
const HEADERS = ["מחלקה", "סוג"];

// Hardcoded kinds — same labels as TaskCreateForm.tsx today. The seed
// uses these as the column-2 source. After seeding, the sheet IS the
// source of truth and these constants stop mattering.
const SEED_KINDS = [
  "קריאייטיב פרסומי",
  "דף נחיתה",
  "וידאו",
  "קופי",
  "השקת קמפיין",
  "סבב תיקונים",
  "אחר",
];

const auth = new google.auth.JWT({
  email: k.client_email,
  key: k.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  subject: SUBJECT,
});
const sheets = google.sheets({ version: "v4", auth });

// Read distinct roles from the "names to emails" tab — those become
// the department list.
const namesRes = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID_COMMENTS,
  range: "names to emails",
  valueRenderOption: "UNFORMATTED_VALUE",
});
const namesRows = namesRes.data.values || [];
const namesHeaders = (namesRows[0] || []).map((h) =>
  String(h ?? "").trim().toLowerCase(),
);
const iRole = namesHeaders.findIndex((h) => h === "role" || h === "תפקיד");
if (iRole < 0) {
  console.error(`names-to-emails has no "role" / "תפקיד" column. Headers: ${namesHeaders.join(" | ")}`);
  process.exit(1);
}
const roleSet = new Set();
for (let r = 1; r < namesRows.length; r++) {
  const role = String(namesRows[r][iRole] ?? "").trim();
  if (role) roleSet.add(role);
}
const departments = [...roleSet].sort((a, b) => a.localeCompare(b, "he"));
console.log(`Distinct departments from names-to-emails: ${departments.length}`);
departments.forEach((d, i) => console.log(`  ${i + 1}. ${d}`));
console.log(`\nKinds (hardcoded seed): ${SEED_KINDS.length}`);
SEED_KINDS.forEach((k, i) => console.log(`  ${i + 1}. ${k}`));

// Check whether TaskFormSchema tab already exists.
const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID_COMMENTS });
const existingTab = (meta.data.sheets ?? []).find(
  (s) => s.properties?.title === TAB,
);
if (existingTab) {
  console.log(`\nTab "${TAB}" already exists (sheetId=${existingTab.properties?.sheetId}).`);
  // If it has rows beyond the header, no-op.
  const cur = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID_COMMENTS,
    range: TAB,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const curRows = cur.data.values || [];
  if (curRows.length > 1) {
    console.log(`  ${curRows.length - 1} data row(s) already present. No-op.`);
    console.log(`  To force a re-seed: delete the tab in Google Sheets and re-run.`);
    process.exit(0);
  }
  console.log(`  Tab exists but is empty — will (re)seed.`);
}

// Build rows: one (department, kind) per row. Cartesian product.
const newRows = [];
for (const d of departments) {
  for (const k of SEED_KINDS) {
    newRows.push([d, k]);
  }
}
console.log(`\nWill seed ${newRows.length} rows (${departments.length} × ${SEED_KINDS.length}).`);

if (!COMMIT) {
  console.log("\nDry-run only. Re-run with --commit to apply.");
  console.log("\nFirst 10 rows preview:");
  newRows.slice(0, 10).forEach((r) => console.log(`  ${r[0]} | ${r[1]}`));
  process.exit(0);
}

// Create the tab if it doesn't exist.
if (!existingTab) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID_COMMENTS,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {
              title: TAB,
              gridProperties: { rowCount: 200, columnCount: 4 },
            },
          },
        },
      ],
    },
  });
  console.log(`Created tab "${TAB}".`);
}

// Write headers + rows.
await sheets.spreadsheets.values.update({
  spreadsheetId: SHEET_ID_COMMENTS,
  range: `${TAB}!A1:B${newRows.length + 1}`,
  valueInputOption: "RAW",
  requestBody: { values: [HEADERS, ...newRows] },
});
console.log(`Wrote header + ${newRows.length} rows.`);
console.log(`\nDone. The hub will pick up the new schema on next /tasks/new render.`);
