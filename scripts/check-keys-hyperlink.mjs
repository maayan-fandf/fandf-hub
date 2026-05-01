/* eslint-disable */
// Read the Ctrl-K hyperlink stored on a Keys row's `campaign ID` cell
// (col F). Used to debug the "פתח בגיליון" / "📊 גיליון" button — the
// dashboard reads this hyperlink as-is, so a wrong tab gid is a Keys-
// data issue, not a code issue.
//
// Run: node scripts/check-keys-hyperlink.mjs "<project>" [<subject>]
import { google } from "googleapis";
import fs from "node:fs";

const PROJECT = process.argv[2] || "קאזר";
const SUBJECT = process.argv[3] || "maayan@fandf.co.il";

const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
const env = (n) => process.env[n] || (envText.split("\n").find((l) => l.startsWith(n + "=")) || "").replace(/^[^=]+=/, "");

const k = JSON.parse(env("TASKS_SA_KEY_JSON"));
const auth = new google.auth.JWT({
  email: k.client_email, key: k.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  subject: SUBJECT,
});
const sheets = google.sheets({ version: "v4", auth });
const ssId = env("SHEET_ID_MAIN");

// First locate the row + col indices.
const r = await sheets.spreadsheets.values.get({
  spreadsheetId: ssId, range: "Keys", valueRenderOption: "UNFORMATTED_VALUE",
});
const rows = r.data.values ?? [];
const headers = (rows[0] ?? []).map((h) => String(h ?? "").replace(/[​-‏‪-‮⁠­﻿]/g, "").replace(/\s+/g, " ").trim());
const iProj = headers.indexOf("פרוייקט");
const iCamp = headers.indexOf("campaign ID");
console.log(`Headers found: פרוייקט=${iProj}  campaign ID=${iCamp}`);

let rowIdx = -1;
for (let i = 1; i < rows.length; i++) {
  if (String(rows[i][iProj] ?? "").trim() === PROJECT) { rowIdx = i; break; }
}
if (rowIdx < 0) { console.error(`[FAIL] project "${PROJECT}" not found`); process.exit(1); }
console.log(`Project row: ${rowIdx + 1}`);

// Now read with includeGridData to get hyperlink + textFormatRuns.
const ss = await sheets.spreadsheets.get({
  spreadsheetId: ssId,
  ranges: [`Keys!A${rowIdx + 1}:Z${rowIdx + 1}`],
  fields: "sheets(data(rowData(values(formattedValue,hyperlink,textFormatRuns(format(link/uri))))))",
});
const sheetData = ss.data.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values ?? [];
const cell = sheetData[iCamp];
console.log(`\ncell formattedValue: "${cell?.formattedValue ?? ""}"`);
console.log(`cell.hyperlink: ${cell?.hyperlink ?? "(none)"}`);
if (cell?.textFormatRuns) {
  console.log(`textFormatRuns:`);
  for (const run of cell.textFormatRuns) {
    console.log(`  link.uri: ${run?.format?.link?.uri ?? "(none)"}`);
  }
}

// Show the all-tabs gid map so the user can see what 38318922 vs 1740338180 actually maps to.
console.log(`\nAll tabs in this spreadsheet (sheetId/gid → title):`);
const meta = await sheets.spreadsheets.get({ spreadsheetId: ssId, fields: "sheets.properties(sheetId,title)" });
const tabs = (meta.data.sheets ?? []).map((s) => s.properties).filter(Boolean);
tabs.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
for (const t of tabs) {
  const flag = (String(t.sheetId) === "1740338180" || String(t.sheetId) === "38318922") ? "  ← " : "";
  console.log(`  ${t.sheetId}\t${t.title}${flag}`);
}
