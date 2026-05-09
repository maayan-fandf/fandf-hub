/* eslint-disable */
// Dump ALL CLIENTS rows for a specific project, showing each row's
// סוג שורה (row type), start date, channel, spend, leads — so we can
// see why a project isn't showing the expected month on the dashboard.
//
// Run: node scripts/dump-allclients-rows.mjs "<project-slug-or-he>" [<subject>]
import { google } from "googleapis";
import fs from "node:fs";

const TARGET = process.argv[2] || "cazar";
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

const r = await sheets.spreadsheets.values.get({
  spreadsheetId: ssId, range: "ALL CLIENTS", valueRenderOption: "UNFORMATTED_VALUE",
});
const rows = r.data.values ?? [];
const headers = (rows[0] ?? []).map((h) => String(h ?? "").replace(/[​-‏‪-‮⁠­﻿]/g, "").replace(/\s+/g, " ").trim());

const cols = {
  rowType: headers.indexOf("סוג שורה"),
  project: headers.indexOf("פרוייקט"),
  projId: headers.indexOf("מזהה מע\"פ"),
  channel: headers.indexOf("מזהה BMBY"),
  start: headers.indexOf("התחלה"),
  end: headers.indexOf("סיום"),
  spend: headers.indexOf("עלות"),
  leads: headers.indexOf("לידים CRM"),
};
console.log("Header indices:", cols, "\n");

const target = TARGET.toLowerCase().trim();
const matches = [];
for (let i = 1; i < rows.length; i++) {
  const proj = String(rows[i][cols.project] ?? "").toLowerCase().trim();
  const slug = String(rows[i][cols.projId] ?? "").toLowerCase().trim();
  if (proj === target || slug === target) {
    matches.push({ idx: i + 1, row: rows[i] });
  }
}
console.log(`Found ${matches.length} rows for "${TARGET}"\n`);

console.log(`${"row".padStart(4)} ${"rowType".padEnd(10)} ${"channel".padEnd(20)} ${"start".padEnd(12)} ${"end".padEnd(12)} ${"spend".padStart(10)} ${"leads".padStart(7)}`);
console.log("─".repeat(80));
for (const m of matches) {
  const row = m.row;
  const rt = String(row[cols.rowType] ?? "");
  const ch = String(row[cols.channel] ?? "");
  const st = formatDateValue(row[cols.start]);
  const en = formatDateValue(row[cols.end]);
  const sp = String(row[cols.spend] ?? "");
  const ld = String(row[cols.leads] ?? "");
  console.log(`${String(m.idx).padStart(4)} ${rt.padEnd(10)} ${ch.padEnd(20)} ${st.padEnd(12)} ${en.padEnd(12)} ${sp.padStart(10)} ${ld.padStart(7)}`);
}

function formatDateValue(v) {
  if (v == null || v === "") return "";
  if (typeof v === "number") {
    // Sheets serial date
    const d = new Date(Math.round((v - 25569) * 86400000));
    if (!Number.isFinite(d.getTime())) return String(v);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  }
  return String(v).slice(0, 12);
}
