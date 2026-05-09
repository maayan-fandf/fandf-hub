/* eslint-disable */
// Diagnostic: dump the raw Traffic.information rows so we can see whether
// the API is returning per-URL breakdown rows that we're summing across
// (workspace total) instead of filtering to the single requested URL.
import fs from "node:fs";
const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
const env = (n) => process.env[n] || (envText.split("\n").find((l) => l.startsWith(n + "=")) || "").replace(/^[^=]+=/, "");

import { google } from "googleapis";
const key = JSON.parse(env("TASKS_SA_KEY_JSON"));
const auth = new google.auth.JWT({
  email: key.client_email, key: key.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  subject: "maayan@fandf.co.il",
});
const sheets = google.sheets({ version: "v4", auth });
const r = await sheets.spreadsheets.values.get({
  spreadsheetId: env("SHEET_ID_MAIN"), range: "Keys", valueRenderOption: "UNFORMATTED_VALUE",
});
const rows = r.data.values ?? [];
const headers = (rows[0] ?? []).map((h) => String(h ?? "").replace(/\s+/g, " ").trim());
const iProj = headers.indexOf("פרוייקט");
const iTok = headers.indexOf("Clarity API Token");
const iLand = headers.indexOf("Landing URL");
const found = rows.find((r) => String(r[iProj] ?? "").trim() === "קאזר");
const tok = String(found[iTok] ?? "").trim();
const url = String(found[iLand] ?? "").trim();

console.log(`Probing: ${url}`);

// Try three variations to see which (if any) actually filters
const variants = [
  { name: "dimension1=URL + dimension1Filter=<url>", params: { numOfDays: "3", dimension1: "URL", dimension1Filter: url } },
  { name: "dimension1=URL only (no filter)",         params: { numOfDays: "3", dimension1: "URL" } },
  { name: "no dimension at all",                      params: { numOfDays: "3" } },
];

for (const v of variants) {
  const qp = new URLSearchParams(v.params);
  const res = await fetch(`https://www.clarity.ms/export-data/api/v1/project-live-insights?${qp}`, {
    headers: { authorization: `Bearer ${tok}` },
  });
  const body = await res.text();
  const parsed = JSON.parse(body);
  console.log(`\n=== ${v.name} ===`);
  const traffic = parsed.find((b) => b?.metricName === "Traffic");
  if (!traffic) { console.log("  no Traffic block"); continue; }
  console.log(`  Traffic.information has ${traffic.information?.length ?? 0} rows`);
  // Show every row's URL + sessions
  for (const row of (traffic.information ?? [])) {
    const u = row.URL ?? row.url ?? row.pageUrl ?? "(no URL key)";
    const s = row.totalSessionCount ?? row.sessions ?? "(no session key)";
    console.log(`    URL=${String(u).slice(0, 80).padEnd(80)} sessions=${s}`);
  }
  // First-row keys
  if (traffic.information?.[0]) {
    console.log(`  first-row keys: ${Object.keys(traffic.information[0]).join(", ")}`);
  }
}
