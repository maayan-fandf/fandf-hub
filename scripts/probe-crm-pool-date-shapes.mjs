/* eslint-disable */
import { google } from "googleapis";
import fs from "node:fs";

const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local","utf8") : "";
const env = (n) => process.env[n] || (envText.split("\n").find(l=>l.startsWith(n+"="))||"").replace(/^[^=]+=/,"");
const k = JSON.parse(env("TASKS_SA_KEY_JSON"));
const jwt = new google.auth.JWT({ email:k.client_email, key:k.private_key, scopes:["https://www.googleapis.com/auth/spreadsheets"], subject:"maayan@fandf.co.il" });
const sheets = google.sheets({ version:"v4", auth: jwt });
const SHEET_ID = "1tYtnB1Ve8RcsZ9_PpRuZyE0jlhD6r-Q35yLO5_7FhEQ";

async function read(tab, mode, range) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${tab}!${range}`,
    valueRenderOption: mode,
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  return res.data.values ?? [];
}

function shape(v) {
  if (v == null || v === "") return "(blank)";
  if (typeof v === "number") return "number";
  if (typeof v === "string") {
    if (/^\d+(\.\d+)?$/.test(v)) return "number-string";
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return "ISO-datetime";
    if (/^\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}/.test(v)) return "YYYY-MM-DD HH:MM";
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return "YYYY-MM-DD";
    if (/^\d{1,2}-\d{1,2}-\d{4} \d{1,2}:\d{2}/.test(v)) return "DD-MM-YYYY HH:MM";
    if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(v)) return "DD-MM-YYYY";
    if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(v)) return "DD/MM/YYYY";
    return `text: "${v.slice(0, 40)}"`;
  }
  return `unknown-${typeof v}`;
}

async function audit(tab, dateColumns) {
  console.log(`\n========== ${tab} ==========`);
  const rows = await read(tab, "UNFORMATTED_VALUE", "A2:AA50000");
  console.log(`Rows: ${rows.length}`);
  for (const { idx, name } of dateColumns) {
    const shapes = new Map();
    const examples = new Map(); // shape → first 3 examples
    for (const row of rows) {
      const v = row[idx];
      const s = shape(v);
      shapes.set(s, (shapes.get(s) || 0) + 1);
      if (!examples.has(s)) examples.set(s, []);
      const arr = examples.get(s);
      if (arr.length < 3) arr.push(v);
    }
    console.log(`\n  ${name} (col ${idx}):`);
    for (const [s, c] of [...shapes.entries()].sort((a, b) => b[1] - a[1])) {
      const ex = examples.get(s).map((v) => typeof v === "string" ? `"${v}"` : v).join(", ");
      console.log(`    ${c.toString().padStart(6)}  ${s.padEnd(28)}  examples: ${ex}`);
    }
  }
}

await audit("מאגר במבי", [
  { idx: 3, name: "תאריך כניסה" },
  { idx: 4, name: "תאריך קשר" },
]);

await audit("מאגר שכל", [
  { idx: 11, name: "תאריך פגישה אחרונה" },
  { idx: 15, name: "תאריך רישום" },
  { idx: 16, name: "עדכון אחרון" },
]);
