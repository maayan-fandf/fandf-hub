/* eslint-disable */
// Diagnostic: dump the names_to_emails tab so we can see what columns
// exist (user just added a Hebrew-name column) and figure out which
// header to pick up in the resolver code.
import fs from "node:fs";
const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
const env = (n) => process.env[n] || (envText.split("\n").find((l) => l.startsWith(n + "=")) || "").replace(/^[^=]+=/, "");
import { google } from "googleapis";
const key = JSON.parse(env("TASKS_SA_KEY_JSON"));
const auth = new google.auth.JWT({ email: key.client_email, key: key.private_key, scopes: ["https://www.googleapis.com/auth/spreadsheets"], subject: "maayan@fandf.co.il" });
const sheets = google.sheets({ version: "v4", auth });
const r = await sheets.spreadsheets.values.get({
  spreadsheetId: env("SHEET_ID_COMMENTS"),
  range: "names to emails",
  valueRenderOption: "UNFORMATTED_VALUE",
});
const rows = r.data.values ?? [];
console.log("Headers:", rows[0]);
console.log("Total data rows:", rows.length - 1);
console.log("\nFirst 8 rows:");
for (let i = 0; i < Math.min(rows.length, 9); i++) {
  console.log(`  row ${i}:`, JSON.stringify(rows[i]));
}
