/* eslint-disable */
/**
 * One-off: probe the Consolidated CRM workbook (BMBY + Sehel tabs)
 * against Keys, and print a digest of how well it joins.
 *
 * The goal: validate before we wire CRM data into the dashboard that
 *   1. Each Keys row with `CRM` + `CRM platform` matches rows in the
 *      external source tab.
 *   2. The join key choice (פרויקט vs שם החברה for BMBY; פרויקט for
 *      Sehel) is correct.
 *   3. We can extract clean funnel numbers: total leads, meetings,
 *      top statuses, top objections, salesperson distribution.
 *
 * Read-only. Run: node scripts/probe-crm-data.mjs
 */
import { google } from "googleapis";
import fs from "node:fs";

const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local","utf8") : "";
const env = (n) => process.env[n] || (envText.split("\n").find(l=>l.startsWith(n+"="))||"").replace(/^[^=]+=/,"");
const k = JSON.parse(env("TASKS_SA_KEY_JSON"));

function jwt(scopes, subject = "maayan@fandf.co.il") {
  return new google.auth.JWT({ email:k.client_email, key:k.private_key, scopes, subject });
}

const SHEET_ID_KEYS = env("SHEET_ID_MAIN");
const SHEET_ID_CRM = "1YOL2RryfXlHPvg0iT5TsLCxkm7L-iTMrAEBWh5Q4Qpc";

// Use the write scope — the .readonly variant isn't in DWD authorization
// for this SA; .../auth/spreadsheets is a superset and works for reads.
const sheets = google.sheets({ version:"v4", auth: jwt(["https://www.googleapis.com/auth/spreadsheets"]) });

// ── Read Keys (project, company, CRM, CRM platform) ───────────────────
console.log("Reading Keys...");
const keysRes = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID_KEYS,
  range: "Keys!A1:P200",
  valueRenderOption: "UNFORMATTED_VALUE",
});
const keysRows = keysRes.data.values || [];
const kh = (keysRows[0] || []).map((h) => String(h ?? "").replace(/\s+/g, " ").trim());
const iProj = kh.indexOf("פרוייקט");
const iCo = kh.indexOf("חברה");
const iCrm = kh.indexOf("CRM");
const iPlatform = kh.indexOf("CRM platform");
if (iProj < 0 || iCrm < 0 || iPlatform < 0) {
  console.error("Keys missing one of: פרוייקט / CRM / CRM platform. Headers:", kh);
  process.exit(1);
}

const keysIndex = []; // { project, company, crmName, platform }
for (let r = 1; r < keysRows.length; r++) {
  const row = keysRows[r];
  const project = String(row[iProj] ?? "").trim();
  const company = String(row[iCo] ?? "").trim();
  const crmName = String(row[iCrm] ?? "").trim();
  const platform = String(row[iPlatform] ?? "").trim().toLowerCase();
  if (!project) continue;
  keysIndex.push({ project, company, crmName, platform });
}
console.log(`Keys rows: ${keysIndex.length} total, ${keysIndex.filter(k=>k.crmName).length} with CRM name set.`);
const platCounts = {};
for (const k of keysIndex) platCounts[k.platform || "(blank)"] = (platCounts[k.platform || "(blank)"] || 0) + 1;
console.log("Platform distribution in Keys:", platCounts);

// ── Read BMBY tab ──────────────────────────────────────────────────────
console.log("\nReading BMBY tab (this is the big one)...");
const bmbyRes = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID_CRM,
  range: "BMBY!A1:AK10000",
  valueRenderOption: "UNFORMATTED_VALUE",
});
const bmbyRows = bmbyRes.data.values || [];
const bh = (bmbyRows[0] || []).map((h) => String(h ?? "").trim());
const bColEntry = bh.indexOf("תאריך כניסה");
const bColStatus = bh.indexOf("סטאטוס");
const bColSeller = bh.indexOf("איש מכירות");
const bColSource = bh.indexOf("מקור הגעה");
const bColProject = bh.indexOf("פרויקט");
const bColCompany = bh.indexOf("שם החברה");
const bColObjection = bh.indexOf("התנגדויות");
const bColMeeting = bh.indexOf("is_meeting");
console.log(`BMBY rows: ${bmbyRows.length - 1} (after header). Header positions: entry=${bColEntry} status=${bColStatus} seller=${bColSeller} source=${bColSource} project=${bColProject} company=${bColCompany} objection=${bColObjection} meeting=${bColMeeting}`);

// Quick distribution of BMBY.פרויקט values
const bmbyProjectCounts = new Map();
const bmbyCompanyCounts = new Map();
for (let r = 1; r < bmbyRows.length; r++) {
  const row = bmbyRows[r];
  const p = String(row[bColProject] ?? "").trim();
  const c = String(row[bColCompany] ?? "").trim();
  if (p) bmbyProjectCounts.set(p, (bmbyProjectCounts.get(p) || 0) + 1);
  if (c) bmbyCompanyCounts.set(c, (bmbyCompanyCounts.get(c) || 0) + 1);
}
console.log(`BMBY distinct פרויקט values: ${bmbyProjectCounts.size}`);
console.log(`BMBY distinct שם החברה values: ${bmbyCompanyCounts.size}`);
console.log("Top 10 BMBY פרויקט values by row count:");
const topB = [...bmbyProjectCounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10);
for (const [n, c] of topB) console.log(`  ${c.toString().padStart(5)}  ${n}`);

// ── Read Sehel tab ─────────────────────────────────────────────────────
console.log("\nReading Sehel tab...");
const sehelRes = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID_CRM,
  // Sehel row 1 is a merged banner; the real header is row 2.
  range: "Sehel!A2:T1500",
  valueRenderOption: "UNFORMATTED_VALUE",
});
const sehelRows = sehelRes.data.values || [];
const sh = (sehelRows[0] || []).map((h) => String(h ?? "").trim());
const sColName = sh.indexOf("שם");
const sColPhone = sh.indexOf("טלפון");
const sColCity = sh.indexOf("עיר מגורים");
const sColStage = sh.indexOf("שלב טיפול");
const sColMeetingDate = sh.indexOf("תאריך פגישה אחרונה");
const sColProject = sh.indexOf("פרויקט");
const sColObjection = sh.indexOf("התנגדויות");
const sColRegDate = sh.indexOf("תאריך רישום");
const sColSource = sh.indexOf("מקור הגעה");
console.log(`Sehel rows: ${sehelRows.length - 1}. Header positions: stage=${sColStage} project=${sColProject} meetingDate=${sColMeetingDate} regDate=${sColRegDate}`);

const sehelProjectCounts = new Map();
for (let r = 1; r < sehelRows.length; r++) {
  const p = String((sehelRows[r] || [])[sColProject] ?? "").trim();
  if (p) sehelProjectCounts.set(p, (sehelProjectCounts.get(p) || 0) + 1);
}
console.log(`Sehel distinct פרויקט values: ${sehelProjectCounts.size}`);
console.log("Top 10 Sehel פרויקט values by row count:");
const topS = [...sehelProjectCounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10);
for (const [n, c] of topS) console.log(`  ${c.toString().padStart(5)}  ${n}`);

// ── Join analysis ─────────────────────────────────────────────────────
console.log("\n── Join analysis ──────────────────────────────────────");
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
let totalKeysJoined = 0, totalRowsJoined = 0;
const perProject = [];

for (const k of keysIndex) {
  if (!k.crmName || !k.platform) continue;
  const target = norm(k.crmName);
  let matchedRows = 0;
  let meetings = 0;
  const objections = new Map();
  const sellers = new Map();
  const sources = new Map();
  const statuses = new Map();

  if (k.platform === "bmby") {
    for (let r = 1; r < bmbyRows.length; r++) {
      const row = bmbyRows[r];
      const proj = norm(row[bColProject]);
      if (proj !== target) continue;
      matchedRows++;
      const isMeeting = String(row[bColMeeting] ?? "").trim();
      if (isMeeting === "1" || isMeeting.toLowerCase() === "true") meetings++;
      const obj = norm(row[bColObjection]); if (obj) objections.set(obj, (objections.get(obj)||0)+1);
      const sel = norm(row[bColSeller]);   if (sel) sellers.set(sel, (sellers.get(sel)||0)+1);
      const src = norm(row[bColSource]);   if (src) sources.set(src, (sources.get(src)||0)+1);
      const sta = norm(row[bColStatus]);   if (sta) statuses.set(sta, (statuses.get(sta)||0)+1);
    }
  } else if (k.platform === "sehel") {
    for (let r = 1; r < sehelRows.length; r++) {
      const row = sehelRows[r] || [];
      const proj = norm(row[sColProject]);
      if (proj !== target) continue;
      matchedRows++;
      const md = String(row[sColMeetingDate] ?? "").trim();
      if (md) meetings++; // Sehel has no boolean — use "any meeting date set" as a proxy
      const obj = norm(row[sColObjection]); if (obj) objections.set(obj, (objections.get(obj)||0)+1);
      const src = norm(row[sColSource]);    if (src) sources.set(src, (sources.get(src)||0)+1);
      const sta = norm(row[sColStage]);     if (sta) statuses.set(sta, (statuses.get(sta)||0)+1);
    }
  } else {
    continue;
  }

  if (matchedRows > 0) { totalKeysJoined++; totalRowsJoined += matchedRows; }
  perProject.push({ ...k, matchedRows, meetings, objections, sellers, sources, statuses });
}

const haveCrm = keysIndex.filter(k => k.crmName && k.platform).length;
console.log(`Keys rows with CRM+platform: ${haveCrm}`);
console.log(`  ...of which had ≥1 matching row in the source tab: ${totalKeysJoined}`);
console.log(`  ...total CRM rows joined across all projects: ${totalRowsJoined}`);
console.log(`  ...0-match Keys rows (worth checking): ${haveCrm - totalKeysJoined}`);

console.log("\n── Per-project digest (sorted by matched-row count) ──");
perProject.sort((a,b) => b.matchedRows - a.matchedRows);
for (const p of perProject) {
  const meetingRate = p.matchedRows > 0 ? ((p.meetings / p.matchedRows) * 100).toFixed(1) + "%" : "—";
  const topObj = [...p.objections.entries()].sort((a,b)=>b[1]-a[1]).slice(0,3).map(([n,c])=>`${n}(${c})`).join(", ");
  const topStatus = [...p.statuses.entries()].sort((a,b)=>b[1]-a[1]).slice(0,3).map(([n,c])=>`${n}(${c})`).join(", ");
  console.log(`${p.platform.padEnd(5)} ${(p.company + "/" + p.project).padEnd(38)} CRM="${p.crmName}"  rows=${String(p.matchedRows).padStart(4)}  meetings=${String(p.meetings).padStart(3)} (${meetingRate})`);
  if (p.matchedRows > 0) {
    if (topObj) console.log(`        objections: ${topObj}`);
    if (topStatus) console.log(`        statuses:   ${topStatus}`);
  }
}

// ── Orphans: CRM-tab values that don't match any Keys.CRM ─────────────
console.log("\n── Orphan CRM source rows (no Keys.CRM match) ──");
const allKeysCrmNorms = new Set(keysIndex.filter(k=>k.crmName).map(k=>norm(k.crmName)));
const orphansBmby = new Map();
for (const [proj, count] of bmbyProjectCounts) {
  if (!allKeysCrmNorms.has(norm(proj))) orphansBmby.set(proj, count);
}
const orphansSehel = new Map();
for (const [proj, count] of sehelProjectCounts) {
  if (!allKeysCrmNorms.has(norm(proj))) orphansSehel.set(proj, count);
}
console.log(`BMBY orphan פרויקט values (in BMBY but not in Keys.CRM): ${orphansBmby.size} distinct, ${[...orphansBmby.values()].reduce((a,b)=>a+b,0)} rows`);
const topOB = [...orphansBmby.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12);
for (const [n, c] of topOB) console.log(`  ${c.toString().padStart(5)}  ${n}`);
console.log(`Sehel orphan פרויקט values: ${orphansSehel.size} distinct, ${[...orphansSehel.values()].reduce((a,b)=>a+b,0)} rows`);
const topOS = [...orphansSehel.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12);
for (const [n, c] of topOS) console.log(`  ${c.toString().padStart(5)}  ${n}`);

// ── Recency check: how recent are the BMBY/Sehel dates? ───────────────
console.log("\n── Date range of source data ──");
let minD = "9999", maxD = "0000", parsed = 0;
for (let r = 1; r < bmbyRows.length; r++) {
  const d = String(bmbyRows[r][bColEntry] ?? "").trim();
  if (!d) continue;
  parsed++;
  if (d < minD) minD = d;
  if (d > maxD) maxD = d;
}
console.log(`BMBY תאריך כניסה: ${parsed} dated rows, range ${minD} → ${maxD}`);
minD = "9999"; maxD = "0000"; parsed = 0;
for (let r = 1; r < sehelRows.length; r++) {
  const d = String((sehelRows[r]||[])[sColRegDate] ?? "").trim();
  if (!d) continue;
  parsed++;
  if (d < minD) minD = d;
  if (d > maxD) maxD = d;
}
console.log(`Sehel תאריך רישום: ${parsed} dated rows, range ${minD} → ${maxD}`);
