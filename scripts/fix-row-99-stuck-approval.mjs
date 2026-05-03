/* eslint-disable */
// One-shot: fix row 99 (T-moiqb2iq-74jk / "פרשקובסקי אשדוד - תוספת בטרגור").
//
// State as of 2026-05-03 sweep:
//   - row_kind=task, status=awaiting_approval
//   - approver_email is empty
//   - google_tasks cell has only maayan/todo, no approve entry
//   - todo GT was completed by maayan on 2026-04-28
//   - mentions field has only maayan (self-task)
//
// Why this is anomalous:
//   autoTransitionTarget("todo", "in_progress", "") returns "done" — the
//   transition to awaiting_approval requires a non-empty approver_email.
//   The current state (status=awaiting_approval AND approver=empty) is
//   not reachable through the current code, so this is legacy data
//   from before the approver-presence guard, OR a manual sheet edit
//   that cleared approver_email after the transition.
//
// Right action: transition to done. The todo was completed 5 days ago,
// no one is meant to approve it. Append a status_history entry for the
// audit trail; mark updated_at; no GT side effects (the todo GT is
// already completed; no approve GT was spawned).
//
// Idempotent: re-running is a no-op (row will already be `done`).
//
// Usage:
//   node scripts/fix-row-99-stuck-approval.mjs            # dry-run
//   node scripts/fix-row-99-stuck-approval.mjs --apply    # apply

import { google } from "googleapis";
import fs from "node:fs";

const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
function envFromFile(name) {
  const line = envText.split("\n").find((l) => l.startsWith(name + "="));
  return line ? line.replace(/^[^=]+=/, "") : "";
}
function loadKey() {
  return JSON.parse(process.env.TASKS_SA_KEY_JSON || envFromFile("TASKS_SA_KEY_JSON"));
}
function jwt(scopes, subject) {
  const k = loadKey();
  return new google.auth.JWT({ email: k.client_email, key: k.private_key, scopes, subject });
}

const APPLY = process.argv.includes("--apply");
const SUBJECT = "maayan@fandf.co.il";
const SHEET_ID_COMMENTS = process.env.SHEET_ID_COMMENTS || envFromFile("SHEET_ID_COMMENTS");
const TARGET_ID = "T-moiqb2iq-74jk";

const sheets = google.sheets({
  version: "v4",
  auth: jwt(["https://www.googleapis.com/auth/spreadsheets"], SUBJECT),
});

function columnLetter(n) {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const cRes = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID_COMMENTS,
  range: "Comments",
  valueRenderOption: "UNFORMATTED_VALUE",
});
const rows = cRes.data.values ?? [];
const headers = (rows[0] ?? []).map((h) => String(h ?? "").trim());
const idx = (n) => headers.indexOf(n);
const I_ID = idx("id");
const I_STATUS = idx("status");
const I_APPROVER = idx("approver_email");
const I_HISTORY = idx("status_history");
const I_UPDATED = idx("updated_at");
const I_TITLE = idx("title");
const I_PROJECT = idx("project");
const I_KIND = idx("row_kind");

const r = rows.findIndex((row, i) => i > 0 && String(row[I_ID] ?? "").trim() === TARGET_ID);
if (r < 0) {
  console.error(`!! row not found: ${TARGET_ID}`);
  process.exit(1);
}
const sheetRow = r + 1;
const cur = rows[r];

// Pre-flight checks.
const checks = [
  { label: "row_kind == task", ok: String(cur[I_KIND] ?? "").trim() === "task" },
  { label: "id == T-moiqb2iq-74jk", ok: String(cur[I_ID] ?? "").trim() === TARGET_ID },
  { label: "title == 'פרשקובסקי אשדוד - תוספת בטרגור'", ok: String(cur[I_TITLE] ?? "").trim() === "פרשקובסקי אשדוד - תוספת בטרגור" },
  { label: "project == אשדוד", ok: String(cur[I_PROJECT] ?? "").trim() === "אשדוד" },
  { label: "approver_email == empty", ok: String(cur[I_APPROVER] ?? "").trim() === "" },
];
console.log(`Sheet row: ${sheetRow}`);
console.log(`Pre-flight checks:`);
let allOk = true;
for (const c of checks) {
  console.log(`  ${c.ok ? "✓" : "✗"} ${c.label}`);
  if (!c.ok) allOk = false;
}
if (!allOk) {
  console.error("\n!! aborting — sheet structure unexpected");
  process.exit(1);
}

const curStatus = String(cur[I_STATUS] ?? "").trim();
if (curStatus === "done") {
  console.log(`\n✓ row already done — nothing to do.`);
  process.exit(0);
}
if (curStatus !== "awaiting_approval") {
  console.error(`!! status is "${curStatus}", expected "awaiting_approval". Aborting.`);
  process.exit(1);
}

// Compose updates.
const now = new Date().toISOString();
let history = [];
try {
  history = JSON.parse(String(cur[I_HISTORY] ?? "[]") || "[]");
  if (!Array.isArray(history)) history = [];
} catch {
  history = [];
}
history.push({
  at: now,
  by: "system",
  from: "awaiting_approval",
  to: "done",
  note: "recovered: stuck awaiting_approval with empty approver_email; finalized via fix-row-99 script (2026-05-03)",
});

const updates = [
  { range: `Comments!${columnLetter(I_STATUS + 1)}${sheetRow}`, values: [["done"]] },
  { range: `Comments!${columnLetter(I_HISTORY + 1)}${sheetRow}`, values: [[JSON.stringify(history)]] },
  { range: `Comments!${columnLetter(I_UPDATED + 1)}${sheetRow}`, values: [[now]] },
];

console.log(`\nProposed writes:`);
for (const u of updates) {
  const v = u.values[0][0];
  const display = typeof v === "string" && v.length > 100 ? v.slice(0, 100) + "…" : v;
  console.log(`  ${u.range}  ←  "${display}"`);
}

if (!APPLY) {
  console.log(`\n[dry-run] Pass --apply to write.`);
  process.exit(0);
}

await sheets.spreadsheets.values.batchUpdate({
  spreadsheetId: SHEET_ID_COMMENTS,
  requestBody: { valueInputOption: "RAW", data: updates },
});
console.log(`\n✓ row 99 updated to status=done`);
