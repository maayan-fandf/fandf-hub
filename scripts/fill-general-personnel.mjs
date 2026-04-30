/* eslint-disable */
// Populate the per-company "כללי" rows with the same personnel /
// roster fields as the company's other projects. Reasoning: the
// personnel typically don't vary project-to-project within a company,
// and the בלאנק roster on the seeded כללי rows would mean those
// projects show no people on the project page.
//
//   node scripts/fill-general-personnel.mjs              # dry-run (default)
//   node scripts/fill-general-personnel.mjs --commit     # actually write
//
// "Personnel" columns are an explicit list (specified by user
// 2026-04-30): מנהל קמפיינים, Email Client, Access — internal only,
// Client-facing. Other columns (Chat Webhook, EMAIL Manager, account
// IDs, Landing URL, etc.) are left untouched on the כללי rows.
import { google } from "googleapis";
import fs from "node:fs";

const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
function envFromFile(name) {
  const line = envText.split("\n").find((l) => l.startsWith(name + "="));
  return line ? line.replace(/^[^=]+=/, "") : "";
}
const SHEET_ID_MAIN = process.env.SHEET_ID_MAIN || envFromFile("SHEET_ID_MAIN");
const k = JSON.parse(process.env.TASKS_SA_KEY_JSON || envFromFile("TASKS_SA_KEY_JSON"));
const COMMIT = process.argv.includes("--commit");
const SUBJECT = "maayan@fandf.co.il";
const GENERAL = "כללי";

const auth = new google.auth.JWT({
  email: k.client_email, key: k.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  subject: SUBJECT,
});
const sheets = google.sheets({ version: "v4", auth });

const res = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID_MAIN,
  range: "Keys",
  valueRenderOption: "UNFORMATTED_VALUE",
});
const values = res.data.values || [];
const headers = values[0].map((h) =>
  String(h ?? "").replace(/[​-‏‪-‮⁠­﻿]/g, "").replace(/\s+/g, " ").trim(),
);
const I_COMPANY = headers.indexOf("חברה");
const I_PROJECT = headers.indexOf("פרוייקט");

console.log("All Keys columns:");
headers.forEach((h, i) => console.log(`  ${i}: ${h}`));

// Match by trimmed header name so a trailing-space column like
// "Client-facing " still gets picked up.
const PERSONNEL_HEADERS = [
  "מנהל קמפיינים",
  "Email Client",
  "Access — internal only",
  "Client-facing",
];
const personnelIdx = PERSONNEL_HEADERS
  .map((target) => headers.findIndex((h) => h.trim() === target))
  .filter((i) => i >= 0);
const missing = PERSONNEL_HEADERS.filter(
  (target, k) => headers.findIndex((h) => h.trim() === target) < 0,
);
if (missing.length) {
  console.error(`\nMissing personnel headers in Keys: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`\nPersonnel columns to copy (${personnelIdx.length}):`);
personnelIdx.forEach((i) => console.log(`  ${i}: "${headers[i]}"`));

// Build map of company → first non-כללי row's roster cells.
const byCompany = new Map();
for (let r = 1; r < values.length; r++) {
  const row = values[r];
  const company = String(row[I_COMPANY] ?? "").trim();
  const project = String(row[I_PROJECT] ?? "").trim();
  if (!company || project === GENERAL) continue;
  if (!byCompany.has(company)) {
    byCompany.set(company, { sourceRowIdx: r, sourceProject: project });
  }
}

// Find every כללי row and queue updates.
const updates = []; // { range, values }
for (let r = 1; r < values.length; r++) {
  const row = values[r];
  const project = String(row[I_PROJECT] ?? "").trim();
  if (project !== GENERAL) continue;
  const company = String(row[I_COMPANY] ?? "").trim();
  const src = byCompany.get(company);
  if (!src) {
    console.log(`  skip company "${company}": no non-כללי source row found`);
    continue;
  }
  const sourceRow = values[src.sourceRowIdx];
  for (const cIdx of personnelIdx) {
    const sourceVal = sourceRow[cIdx] ?? "";
    const currentVal = row[cIdx] ?? "";
    if (String(currentVal).trim() === String(sourceVal).trim()) continue;
    if (!String(sourceVal).trim()) continue; // don't blank existing data
    const colLetter = columnLetter(cIdx + 1);
    const sheetRow = r + 1; // 1-based, header at row 1
    updates.push({
      company,
      header: headers[cIdx],
      sourceProject: src.sourceProject,
      range: `Keys!${colLetter}${sheetRow}`,
      values: [[sourceVal]],
    });
  }
}

console.log(`\n${updates.length} cells will be updated:`);
const byCompanySummary = new Map();
for (const u of updates) {
  byCompanySummary.set(u.company, (byCompanySummary.get(u.company) ?? 0) + 1);
}
for (const [c, n] of byCompanySummary) {
  console.log(`  ${c}: ${n} cell(s)`);
}

if (updates.length === 0) {
  console.log("\nNothing to do.");
  process.exit(0);
}

if (!COMMIT) {
  console.log("\nDry-run only. Re-run with --commit to actually write.");
  console.log("\nFirst 5 cell updates (preview):");
  updates.slice(0, 5).forEach((u) =>
    console.log(`  ${u.range}  ←  "${String(u.values[0][0]).slice(0, 60)}"  (from ${u.company}/${u.sourceProject}, col=${u.header})`),
  );
  process.exit(0);
}

console.log(`\nWriting ${updates.length} cell update(s)...`);
const result = await sheets.spreadsheets.values.batchUpdate({
  spreadsheetId: SHEET_ID_MAIN,
  requestBody: {
    valueInputOption: "RAW",
    data: updates.map((u) => ({ range: u.range, values: u.values })),
  },
});
console.log(`OK. Total updated cells: ${result.data.totalUpdatedCells}`);

function columnLetter(n) {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
