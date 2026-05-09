/* eslint-disable */
// One-off: list every row matching a project name to spot duplicates
// where one row has Chat Space and another doesn't (find() returns the
// first match, so an empty-cell duplicate placed earlier silently wins).
// Run: node scripts/check-keys-dupes.mjs "<project>" [<subject>]
import { google } from "googleapis";
import fs from "node:fs";

const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
const env = (n) => process.env[n] || (envText.split("\n").find((l) => l.startsWith(n + "=")) || "").replace(/^[^=]+=/, "");

const TARGET = process.argv[2] || "אחוזת אפרידר";
const SUBJECT = process.argv[3] || "maayan@fandf.co.il";

const key = JSON.parse(env("TASKS_SA_KEY_JSON"));
const auth = new google.auth.JWT({
  email: key.client_email,
  key: key.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  subject: SUBJECT,
});
const sheets = google.sheets({ version: "v4", auth });
const r = await sheets.spreadsheets.values.get({
  spreadsheetId: env("SHEET_ID_MAIN"),
  range: "Keys",
  valueRenderOption: "UNFORMATTED_VALUE",
});
const rows = r.data.values ?? [];
const headers = (rows[0] ?? []).map((h) => String(h ?? "").replace(/[​-‏‪-‮⁠­﻿]/g, "").replace(/\s+/g, " ").trim());
const iProj = headers.indexOf("פרוייקט");
const iCo = headers.indexOf("חברה");
const iChat = headers.indexOf("Chat Space") >= 0 ? headers.indexOf("Chat Space") : headers.indexOf("Chat Webhook");

const target = TARGET.toLowerCase().trim();
let hits = 0;
for (let i = 1; i < rows.length; i++) {
  const name = String(rows[i][iProj] ?? "").trim();
  if (name.toLowerCase() === target) {
    hits++;
    const co = String(rows[i][iCo] ?? "").trim();
    const cs = String(rows[i][iChat] ?? "").trim();
    const codes = [...name].map((c) => c.codePointAt(0).toString(16)).join(" ");
    console.log(`row ${i}  company="${co}"  chatSpace="${cs.slice(0, 80)}"`);
    console.log(`  name codepoints: ${codes}`);
  }
}
console.log(`\nTotal matches: ${hits}`);

// Also list any near-misses (project contains target or vice versa)
console.log("\nNear-miss scan (any row containing 'אפרידר'):");
for (let i = 1; i < rows.length; i++) {
  const name = String(rows[i][iProj] ?? "").trim();
  if (name.includes("אפרידר") && name.toLowerCase() !== target) {
    const co = String(rows[i][iCo] ?? "").trim();
    const cs = String(rows[i][iChat] ?? "").trim();
    const codes = [...name].map((c) => c.codePointAt(0).toString(16)).join(" ");
    console.log(`  row ${i}  name="${name}"  company="${co}"  chat="${cs.slice(0, 60)}"`);
    console.log(`    codepoints: ${codes}`);
  }
}
