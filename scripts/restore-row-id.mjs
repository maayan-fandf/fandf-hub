/* eslint-disable */
// One-shot fix: restore the empty `id` on Comments-sheet row 117.
//
// Background — see audit-gt-integration.mjs run from 2026-05-03:
//   row 117 (אורנבך ראשון לציון / "לממשק אתר לבמבי") has row_kind=task,
//   status=awaiting_approval, two well-formed google_tasks entries, but
//   column A (`id`) is empty. The associated GT's notes deep-link points
//   to `T-mokh7lfl-t0yo`, which appears nowhere else in the sheet.
//
// Effect of the empty id:
//   - hub /tasks/T-mokh7lfl-t0yo 404s
//   - reconciliation in pollTasks.ts skips the row (`if (!taskId) continue`)
//   - the row sits in awaiting_approval limbo: itay's approve GT can be
//     completed but the poller can't find a matching row to transition
//
// This script:
//   1. Reads cell A117 to confirm it's empty
//   2. Writes "T-mokh7lfl-t0yo" into A117
//   3. Reads back to verify
//
// Idempotent — running twice is a no-op (the second run sees the value
// already in place and does nothing).

import { google } from "googleapis";
import fs from "node:fs";

const envText = fs.existsSync(".env.local")
  ? fs.readFileSync(".env.local", "utf8")
  : "";
function envFromFile(name) {
  const line = envText.split("\n").find((l) => l.startsWith(name + "="));
  return line ? line.replace(/^[^=]+=/, "") : "";
}

const SUBJECT = "maayan@fandf.co.il";
const SHEET_ID_COMMENTS =
  process.env.SHEET_ID_COMMENTS || envFromFile("SHEET_ID_COMMENTS");
const TARGET_ROW = 117;
const TARGET_ID = "T-mokh7lfl-t0yo";

function loadKey() {
  const raw =
    process.env.TASKS_SA_KEY_JSON || envFromFile("TASKS_SA_KEY_JSON");
  return JSON.parse(raw);
}
function jwt(scopes, subject) {
  const k = loadKey();
  return new google.auth.JWT({
    email: k.client_email,
    key: k.private_key,
    scopes,
    subject,
  });
}

const sheets = google.sheets({
  version: "v4",
  auth: jwt(["https://www.googleapis.com/auth/spreadsheets"], SUBJECT),
});

// 1. Read current value of A117 + the surrounding columns so we can
//    sanity-check we're touching the right row.
const before = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID_COMMENTS,
  range: `Comments!A${TARGET_ROW}:M${TARGET_ROW}`,
  valueRenderOption: "UNFORMATTED_VALUE",
});
const beforeRow = before.data.values?.[0] ?? [];
console.log(`Row ${TARGET_ROW} current state:`);
console.log(`  A (id):        "${beforeRow[0] ?? ""}"`);
console.log(`  B (timestamp): "${beforeRow[1] ?? ""}"`);
console.log(`  C (project):   "${beforeRow[2] ?? ""}"`);
console.log(`  E (author):    "${beforeRow[4] ?? ""}"`);
console.log(`  M (row_kind):  "${beforeRow[12] ?? ""}"`);

// Defensive checks — bail if the row doesn't look like the expected one.
const project = String(beforeRow[2] ?? "").trim();
const rowKind = String(beforeRow[12] ?? "").trim();
const currentId = String(beforeRow[0] ?? "").trim();

if (rowKind !== "task") {
  console.error(`!! row ${TARGET_ROW} has row_kind="${rowKind}", expected "task". Aborting.`);
  process.exit(1);
}
if (project !== "אורנבך ראשון לציון") {
  console.error(
    `!! row ${TARGET_ROW} project is "${project}", expected "אורנבך ראשון לציון". Aborting (sheet structure changed?).`,
  );
  process.exit(1);
}
if (currentId === TARGET_ID) {
  console.log(`\n✓ id is already "${TARGET_ID}" — nothing to do.`);
  process.exit(0);
}
if (currentId !== "") {
  console.error(
    `!! row ${TARGET_ROW} id is "${currentId}", expected "" (empty). Aborting — manual review.`,
  );
  process.exit(1);
}

// 2. Write the id.
console.log(`\nWriting "${TARGET_ID}" into A${TARGET_ROW}...`);
await sheets.spreadsheets.values.update({
  spreadsheetId: SHEET_ID_COMMENTS,
  range: `Comments!A${TARGET_ROW}`,
  valueInputOption: "RAW",
  requestBody: { values: [[TARGET_ID]] },
});

// 3. Read back to confirm.
const after = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID_COMMENTS,
  range: `Comments!A${TARGET_ROW}`,
  valueRenderOption: "UNFORMATTED_VALUE",
});
const afterId = String(after.data.values?.[0]?.[0] ?? "").trim();
if (afterId === TARGET_ID) {
  console.log(`✓ verified: A${TARGET_ROW} = "${afterId}"`);
} else {
  console.error(`!! verify failed: A${TARGET_ROW} = "${afterId}"`);
  process.exit(1);
}
