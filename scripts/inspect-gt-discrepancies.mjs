/* eslint-disable */
// Targeted inspection of the discrepancies surfaced by
// audit-gt-integration.mjs. Pulls full bodies for both sides:
//   - The exact GT object from maayan's tasklist (open OR completed)
//   - The full Comments-sheet row for the corresponding hub task id
// Also dumps the row's google_tasks cell verbatim so we can see
// every entry, not just the one that tripped the audit.
//
// Run from hub-next/:  node scripts/inspect-gt-discrepancies.mjs

import { google } from "googleapis";
import fs from "node:fs";

const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
function envFromFile(name) {
  const line = envText.split("\n").find((l) => l.startsWith(name + "="));
  return line ? line.replace(/^[^=]+=/, "") : "";
}
const SUBJECT = "maayan@fandf.co.il";
const SHEET_ID_COMMENTS = process.env.SHEET_ID_COMMENTS || envFromFile("SHEET_ID_COMMENTS");

function loadKey() {
  const raw = process.env.TASKS_SA_KEY_JSON || envFromFile("TASKS_SA_KEY_JSON");
  return JSON.parse(raw);
}
function jwt(scopes, subject) {
  const k = loadKey();
  return new google.auth.JWT({ email: k.client_email, key: k.private_key, scopes, subject });
}

const tasksApi = google.tasks({ version: "v1", auth: jwt(["https://www.googleapis.com/auth/tasks"], SUBJECT) });
const sheets = google.sheets({ version: "v4", auth: jwt(["https://www.googleapis.com/auth/spreadsheets"], SUBJECT) });

const cases = [
  { kind: "GT-CLOSED-BUT-ROW-OPEN", rowId: "",                gtId: "aXVOaHRNT2NueDJTbFpBbw" },
  { kind: "GT-CLOSED-BUT-ROW-OPEN", rowId: "T-moljg5uh-o8zb", gtId: "bXB5Y2RTUXA1ZVJCdjlmVQ" },
  { kind: "PHANTOM",                 rowId: "T-moiqb2iq-74jk", gtId: "YzlJTVktczYwTk5ubFI1Qw" },
  { kind: "PHANTOM",                 rowId: "T-mojtx9zi-m1ed", gtId: "eXMtSWtETDhqbTBUbDB0OA" },
];

const tlRes = await tasksApi.tasklists.list({ maxResults: 5 });
const defaultList = tlRes.data.items[0];

const cRes = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID_COMMENTS,
  range: "Comments",
  valueRenderOption: "UNFORMATTED_VALUE",
});
const cRows = cRes.data.values || [];
const headers = (cRows[0] || []).map((h) => String(h ?? "").trim());
const I_ID = headers.indexOf("id");
const I_KIND = headers.indexOf("row_kind");
const I_STATUS = headers.indexOf("status");
const I_TITLE = headers.indexOf("title");
const I_GTASKS = headers.indexOf("google_tasks");
const I_PROJECT = headers.indexOf("project");
const I_TIMESTAMP = headers.indexOf("timestamp");
const I_AUTHOR = headers.indexOf("author_email");

function rowToObj(row, rowNum) {
  return {
    sheet_row: rowNum + 1, // 1-indexed for Sheets UI
    id: String(row[I_ID] ?? "").trim(),
    row_kind: String(row[I_KIND] ?? "").trim(),
    status: String(row[I_STATUS] ?? "").trim(),
    title: String(row[I_TITLE] ?? "").trim(),
    project: String(row[I_PROJECT] ?? "").trim(),
    author: String(row[I_AUTHOR] ?? "").trim(),
    timestamp: String(row[I_TIMESTAMP] ?? "").trim(),
    google_tasks_raw: String(row[I_GTASKS] ?? "").trim(),
  };
}

async function fetchGT(id) {
  try {
    const r = await tasksApi.tasks.get({ tasklist: defaultList.id, task: id });
    return r.data;
  } catch (e) {
    return { __error: e?.response?.status || String(e?.message || e) };
  }
}

for (const c of cases) {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`${c.kind}    rowId=${c.rowId || "(empty!)"}    gtId=${c.gtId}`);
  console.log("=".repeat(70));

  // GT side
  const gt = await fetchGT(c.gtId);
  if (gt.__error) {
    console.log(`\nGT GET → ERROR: ${gt.__error}`);
  } else {
    console.log(`\nGT GET:`);
    console.log(`  status:  ${gt.status}`);
    console.log(`  title:   ${gt.title}`);
    console.log(`  updated: ${gt.updated}`);
    console.log(`  due:     ${gt.due || "(none)"}`);
    console.log(`  completed: ${gt.completed || "(n/a)"}`);
    console.log(`  links:   ${JSON.stringify(gt.links || [])}`);
    const noteLines = (gt.notes || "").split("\n");
    console.log(`  notes (${noteLines.length} lines):`);
    for (const ln of noteLines.slice(0, 8)) console.log(`    | ${ln}`);
    if (noteLines.length > 8) console.log(`    | ... (+${noteLines.length - 8} lines)`);
  }

  // Sheet side — find row by id, OR find rows referencing the GT id when rowId blank
  if (c.rowId) {
    const r = cRows.findIndex((row, i) => i > 0 && String(row[I_ID] ?? "").trim() === c.rowId);
    if (r > 0) {
      const obj = rowToObj(cRows[r], r);
      console.log(`\nSheet row (id=${c.rowId}, sheet row ${obj.sheet_row}):`);
      console.log(JSON.stringify(obj, null, 2));
    } else {
      console.log(`\n!!! Sheet has NO row with id=${c.rowId}`);
    }
  } else {
    // Find any rows whose google_tasks cell mentions the gtId
    console.log(`\nSearching for rows referencing gtId=${c.gtId}:`);
    let found = 0;
    for (let r = 1; r < cRows.length; r++) {
      const cell = String(cRows[r][I_GTASKS] ?? "");
      if (cell.includes(c.gtId)) {
        found++;
        const obj = rowToObj(cRows[r], r);
        console.log(`  match #${found}:`);
        console.log("  " + JSON.stringify(obj, null, 2).split("\n").join("\n  "));
      }
    }
    if (!found) console.log(`  (no rows found)`);
  }
}

console.log(`\n${"=".repeat(70)}`);
console.log("DONE");
