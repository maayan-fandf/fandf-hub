/* eslint-disable */
// Seed a "כללי" project row in the Keys tab for every distinct
// company that doesn't already have one.
//
//   node scripts/seed-general-projects.mjs                 # dry-run (default)
//   node scripts/seed-general-projects.mjs --commit        # actually append
//
// All other Keys columns (chat webhook, roster, client emails, etc.)
// are left blank. The hub treats name === GENERAL_PROJECT_NAME as the
// "general / non-project work" convention and renders these rows
// with muted styling at the bottom of each company's submenu / grid
// section.
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

if (!SHEET_ID_MAIN) {
  console.error("SHEET_ID_MAIN not set");
  process.exit(1);
}

const auth = new google.auth.JWT({
  email: k.client_email,
  key: k.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  subject: SUBJECT,
});
const sheets = google.sheets({ version: "v4", auth });

// Load Keys.
const res = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID_MAIN,
  range: "Keys",
  valueRenderOption: "UNFORMATTED_VALUE",
});
const values = res.data.values || [];
if (!values.length) { console.error("Keys is empty"); process.exit(1); }
const headers = values[0].map((h) =>
  String(h ?? "").replace(/[​-‏‪-‮⁠­﻿]/g, "").replace(/\s+/g, " ").trim(),
);
const I_COMPANY = headers.indexOf("חברה");
const I_PROJECT = headers.indexOf("פרוייקט");
if (I_COMPANY < 0 || I_PROJECT < 0) {
  console.error(`Required headers missing. Found: ${headers.join(" | ")}`);
  process.exit(1);
}
console.log(`Keys: ${headers.length} columns, ${values.length - 1} rows`);
console.log(`  company col = ${headers[I_COMPANY]} (#${I_COMPANY})`);
console.log(`  project col = ${headers[I_PROJECT]} (#${I_PROJECT})`);

// Walk rows: collect distinct companies + companies that already have a כללי row.
const companies = new Set();
const companiesWithGeneral = new Set();
for (let r = 1; r < values.length; r++) {
  const company = String(values[r][I_COMPANY] ?? "").trim();
  const project = String(values[r][I_PROJECT] ?? "").trim();
  if (!company) continue;
  companies.add(company);
  if (project === GENERAL) companiesWithGeneral.add(company);
}

const toSeed = [...companies].filter((c) => !companiesWithGeneral.has(c)).sort();
console.log(`\nDistinct companies: ${companies.size}`);
console.log(`Already have a "כללי" row: ${companiesWithGeneral.size}`);
console.log(`To seed: ${toSeed.length}`);
toSeed.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));

if (toSeed.length === 0) {
  console.log("\nNothing to do.");
  process.exit(0);
}

if (!COMMIT) {
  console.log("\nDry-run only. Re-run with --commit to actually append.");
  process.exit(0);
}

// Build new rows: array sized to header.length, with project + company cells set,
// every other cell empty string.
const newRows = toSeed.map((company) => {
  const row = headers.map(() => "");
  row[I_COMPANY] = company;
  row[I_PROJECT] = GENERAL;
  return row;
});

console.log(`\nAppending ${newRows.length} row(s) to Keys...`);
const append = await sheets.spreadsheets.values.append({
  spreadsheetId: SHEET_ID_MAIN,
  range: "Keys",
  valueInputOption: "RAW",
  insertDataOption: "INSERT_ROWS",
  requestBody: { values: newRows },
});
console.log(`OK. Updated range: ${append.data.updates?.updatedRange}`);
console.log(`Rows appended: ${append.data.updates?.updatedRows}`);
console.log("\nThe hub's myProjects cache (60s TTL) will pick these up shortly.");
