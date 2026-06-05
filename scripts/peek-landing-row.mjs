// Dump the latest LANDING_PRICES row for one project — used to verify
// that scrape-landing-prices wrote the new `all_prices_json` /
// `yad2_all_prices_json` columns with the room labels we expect.
//
//   node scripts/peek-landing-row.mjs "רמת אפעל"

import { readFileSync } from "node:fs";
import { GoogleAuth } from "google-auth-library";
import { google } from "googleapis";

const PROJECT = (process.argv[2] || "רמת אפעל").trim();

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => {
      const [k, ...rest] = l.split("=");
      return [k.trim(), rest.join("=").trim().replace(/^["']|["']$/g, "")];
    }),
);
const saKey = JSON.parse(env.TASKS_SA_KEY_JSON);
const auth = new GoogleAuth({
  credentials: saKey,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  clientOptions: { subject: env.DRIVE_FOLDER_OWNER || "maayan@fandf.co.il" },
});
const sheets = google.sheets({ version: "v4", auth: await auth.getClient() });

const res = await sheets.spreadsheets.values.get({
  spreadsheetId: env.SHEET_ID_COMMENTS,
  range: "LANDING_PRICES",
  valueRenderOption: "UNFORMATTED_VALUE",
});
const rows = res.data.values || [];
const hdr = rows[0];
console.log("columns:", hdr.join(" | "));
console.log();
const iProj = hdr.indexOf("project");
const row = rows.slice(1).find((r) => String(r[iProj] || "").trim() === PROJECT);
if (!row) {
  console.error(`No LANDING_PRICES row for "${PROJECT}"`);
  process.exit(1);
}
for (let i = 0; i < hdr.length; i++) {
  const col = hdr[i];
  const val = String(row[i] ?? "");
  if (col.endsWith("_json")) {
    console.log(`\n=== ${col} ===`);
    try {
      const parsed = JSON.parse(val || "[]");
      console.log(JSON.stringify(parsed, null, 2));
    } catch (e) {
      console.log(`(unparsable: ${e.message})`);
      console.log(val.slice(0, 300));
    }
  } else {
    console.log(`${col.padEnd(22)} = ${val.length > 90 ? val.slice(0, 90) + "…" : val}`);
  }
}
