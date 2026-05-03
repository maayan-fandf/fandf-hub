/* eslint-disable */
// Quick lookup: search the entire Comments sheet for a given task id,
// across the `id` column AND any other text column where the id might
// appear (parent_id, body references, google_tasks cells with embedded
// hub URLs, etc.).
//
// Run from hub-next/:  node scripts/check-task-id.mjs <task-id>

import { google } from "googleapis";
import fs from "node:fs";

const envText = fs.existsSync(".env.local")
  ? fs.readFileSync(".env.local", "utf8")
  : "";
function envFromFile(name) {
  const line = envText.split("\n").find((l) => l.startsWith(name + "="));
  return line ? line.replace(/^[^=]+=/, "") : "";
}

const TARGET = (process.argv[2] || "").trim();
if (!TARGET) {
  console.error("Usage: node scripts/check-task-id.mjs <task-id>");
  process.exit(1);
}

const SUBJECT = "maayan@fandf.co.il";
const SHEET_ID_COMMENTS =
  process.env.SHEET_ID_COMMENTS || envFromFile("SHEET_ID_COMMENTS");

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
const cRes = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID_COMMENTS,
  range: "Comments",
  valueRenderOption: "UNFORMATTED_VALUE",
});
const cRows = cRes.data.values || [];
const headers = (cRows[0] || []).map((h) => String(h ?? "").trim());

console.log(`Searching Comments sheet for "${TARGET}"`);
console.log(`Total rows: ${cRows.length - 1}`);
console.log(`Headers: ${headers.join(", ")}`);
console.log("---");

let totalMatches = 0;
for (let r = 1; r < cRows.length; r++) {
  const row = cRows[r];
  const matches = [];
  for (let c = 0; c < row.length; c++) {
    const cell = String(row[c] ?? "");
    if (cell.includes(TARGET)) {
      matches.push({
        col: headers[c] || `col${c + 1}`,
        value: cell.length > 200 ? cell.slice(0, 200) + "…" : cell,
      });
    }
  }
  if (matches.length === 0) continue;
  totalMatches++;
  const obj = {};
  for (let c = 0; c < headers.length; c++) {
    obj[headers[c] || `col${c + 1}`] = String(row[c] ?? "");
  }
  console.log(`\n--- Row ${r + 1} (${totalMatches}${totalMatches === 1 ? "st" : "th"} match) ---`);
  console.log(`Matched columns: ${matches.map((m) => m.col).join(", ")}`);
  console.log(`  id:        "${obj.id || ""}"`);
  console.log(`  row_kind:  ${obj.row_kind}`);
  console.log(`  status:    ${obj.status}`);
  console.log(`  parent_id: "${obj.parent_id || ""}"`);
  console.log(`  title:     ${obj.title || obj.body?.slice(0, 80) || ""}`);
  console.log(`  project:   ${obj.project}`);
  console.log(`  author:    ${obj.author_email}`);
  console.log(`  timestamp: ${obj.timestamp}`);
  if (obj.google_tasks) {
    console.log(
      `  google_tasks: ${obj.google_tasks.length > 200 ? obj.google_tasks.slice(0, 200) + "…" : obj.google_tasks}`,
    );
  }
}

console.log(`\n---\nTotal rows containing "${TARGET}": ${totalMatches}`);
