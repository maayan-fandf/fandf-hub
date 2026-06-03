// One-off: dump a project's full row from LANDING_PRICES.
// Used to see what the extractor saw vs. what made it to the
// headline_price column.
//
//   node --experimental-strip-types scripts/probe-landing-row.mjs קאזר
import { readFileSync } from "node:fs";
import { GoogleAuth } from "google-auth-library";
import { google } from "googleapis";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => {
      const [k, ...rest] = l.split("=");
      return [k.trim(), rest.join("=").trim().replace(/^["']|["']$/g, "")];
    }),
);

const wanted = (process.argv[2] || "").trim();
if (!wanted) { console.error("Usage: node probe-landing-row.mjs <project>"); process.exit(1); }

const auth = new GoogleAuth({
  credentials: JSON.parse(env.TASKS_SA_KEY_JSON),
  // DWD is authorised for the read-write spreadsheet scope (same as
  // the scraper); .readonly isn't covered → 401 unauthorized_client.
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  clientOptions: { subject: env.DRIVE_FOLDER_OWNER || "maayan@fandf.co.il" },
});
const sh = google.sheets({ version: "v4", auth: await auth.getClient() });
const res = await sh.spreadsheets.values.get({
  spreadsheetId: env.SHEET_ID_COMMENTS,
  range: "LANDING_PRICES",
  valueRenderOption: "UNFORMATTED_VALUE",
});
const rows = res.data.values || [];
const hdr = rows[0];
const iProj = hdr.indexOf("project");
const iSlug = hdr.indexOf("slug");
const row = rows.find(
  (r, i) => i > 0 && (String(r[iProj] || "") === wanted || String(r[iSlug] || "") === wanted),
);
if (!row) { console.error("Not found"); process.exit(1); }
console.log("Row for " + wanted + ":");
for (let c = 0; c < hdr.length; c++) {
  const v = row[c];
  if (v === "" || v == null) continue;
  console.log("  " + hdr[c].padEnd(22) + " = " + String(v));
}
