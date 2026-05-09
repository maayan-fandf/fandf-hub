/* eslint-disable */
// Smoke-test the patched lib/clarity.ts against the real API for both
// test projects. Should print DIFFERENT numbers per URL — that's the
// regression check for "two projects show identical numbers".
import fs from "node:fs";
const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
const env = (n) => process.env[n] || (envText.split("\n").find((l) => l.startsWith(n + "=")) || "").replace(/^[^=]+=/, "");
import { google } from "googleapis";
const key = JSON.parse(env("TASKS_SA_KEY_JSON"));
const auth = new google.auth.JWT({ email: key.client_email, key: key.private_key, scopes: ["https://www.googleapis.com/auth/spreadsheets"], subject: "maayan@fandf.co.il" });
const sheets = google.sheets({ version: "v4", auth });
const r = await sheets.spreadsheets.values.get({ spreadsheetId: env("SHEET_ID_MAIN"), range: "Keys", valueRenderOption: "UNFORMATTED_VALUE" });
const rows = r.data.values ?? [];
const headers = (rows[0] ?? []).map((h) => String(h ?? "").trim());
const iProj = headers.indexOf("פרוייקט");
const iTok = headers.indexOf("Clarity API Token");
const iLand = headers.indexOf("Landing URL");

// Inline the patched logic so we don't need to bundle TS.
function pathKey(url) {
  try {
    const u = new URL(url);
    return `${u.host.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\?.*$/, "").replace(/#.*$/, "").replace(/\/+$/, "");
  }
}
function numOf(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; }
  return 0;
}
function avgField(rows, field) {
  if (!rows.length) return 0;
  let s = 0, c = 0;
  for (const r of rows) { const n = numOf(r[field]); if (Number.isFinite(n)) { s += n; c++; } }
  return c ? s / c : 0;
}
function aggregateForUrl(parsed, targetKey) {
  const out = { sessions: 0, engagementSecondsAvg: 0, scrollDepthPctAvg: 0, rageClicks: 0, deadClicks: 0, quickbacks: 0, excessiveScroll: 0 };
  const matches = (row) => {
    const u = row.Url ?? row.URL ?? row.url ?? row.pageUrl;
    return typeof u === "string" && pathKey(u) === targetKey;
  };
  for (const block of parsed) {
    const rows = (block.information ?? []).filter(matches);
    switch (block.metricName) {
      case "Traffic": for (const r of rows) out.sessions += numOf(r.totalSessionCount); break;
      case "EngagementTime": out.engagementSecondsAvg = avgField(rows, "activeTime"); break;
      case "ScrollDepth": out.scrollDepthPctAvg = avgField(rows, "averageScrollDepth"); break;
      case "RageClickCount": case "RageClick": for (const r of rows) out.rageClicks += numOf(r.subTotal); break;
      case "DeadClickCount": case "DeadClick": for (const r of rows) out.deadClicks += numOf(r.subTotal); break;
      case "QuickbackClick": case "Quickback": for (const r of rows) out.quickbacks += numOf(r.subTotal); break;
      case "ExcessiveScroll": for (const r of rows) out.excessiveScroll += numOf(r.subTotal); break;
    }
  }
  return out;
}

for (const proj of ["קאזר", "מרום ראשון"]) {
  const found = rows.find((r) => String(r[iProj] ?? "").trim() === proj);
  if (!found) { console.log(`${proj} NOT FOUND`); continue; }
  const tok = String(found[iTok] ?? "").trim();
  const url = String(found[iLand] ?? "").trim();
  const targetKey = pathKey(url);
  const res = await fetch(`https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=3&dimension1=URL`, { headers: { authorization: `Bearer ${tok}` } });
  const parsed = JSON.parse(await res.text());
  const agg = aggregateForUrl(parsed, targetKey);
  console.log(`\n[${proj}]`);
  console.log(`  url:        ${url}`);
  console.log(`  pathKey:    ${targetKey}`);
  console.log(`  insights:   ${JSON.stringify(agg)}`);
}
