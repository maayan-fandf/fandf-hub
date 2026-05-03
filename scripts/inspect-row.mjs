/* eslint-disable */
// Dump every column of a single Comments-sheet row by hub task id.
// Used to inspect a stuck row in detail. Read-only.
//
// Usage: node scripts/inspect-row.mjs <task-id>

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

const TARGET = (process.argv[2] || "").trim();
if (!TARGET) {
  console.error("Usage: node scripts/inspect-row.mjs <task-id>");
  process.exit(1);
}

const SUBJECT = "maayan@fandf.co.il";
const SHEET_ID_COMMENTS = process.env.SHEET_ID_COMMENTS || envFromFile("SHEET_ID_COMMENTS");

const sheets = google.sheets({
  version: "v4",
  auth: jwt(["https://www.googleapis.com/auth/spreadsheets"], SUBJECT),
});
const cRes = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID_COMMENTS,
  range: "Comments",
  valueRenderOption: "UNFORMATTED_VALUE",
});
const rows = cRes.data.values ?? [];
const headers = (rows[0] ?? []).map((h) => String(h ?? "").trim());
const I_ID = headers.indexOf("id");

const r = rows.findIndex((row, i) => i > 0 && String(row[I_ID] ?? "").trim() === TARGET);
if (r < 0) {
  console.error(`No row with id="${TARGET}"`);
  process.exit(1);
}
console.log(`Sheet row: ${r + 1}`);
for (let c = 0; c < headers.length; c++) {
  const h = headers[c] || `col${c + 1}`;
  const v = rows[r][c];
  if (v == null || v === "") continue;
  console.log(`  ${h}: ${typeof v === "string" && v.length > 200 ? v.slice(0, 200) + "…" : v}`);
}
