/* eslint-disable */
// Walk every Keys row, read the Ctrl-K hyperlink on col F (campaign
// ID), resolve its gid against the spreadsheet's tab list, and flag
// any case where the linked tab's title doesn't match the campaign
// ID label. This catches "wrong tab" mistakes like the one that was
// sending קאזר → tidhar-hever.
//
// Read-only — does not modify anything.
//
// Run: node scripts/audit-keys-hyperlinks.mjs [<subject>]
import { google } from "googleapis";
import fs from "node:fs";

const SUBJECT = process.argv[2] || "maayan@fandf.co.il";
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

// 1) Read tab list (gid → title).
const meta = await sheets.spreadsheets.get({ spreadsheetId: ssId, fields: "sheets.properties(sheetId,title)" });
const tabsByGid = new Map();
for (const s of meta.data.sheets ?? []) {
  if (s.properties) tabsByGid.set(String(s.properties.sheetId), s.properties.title);
}

// 2) Read Keys rows with hyperlinks.
const ks = await sheets.spreadsheets.get({
  spreadsheetId: ssId,
  ranges: ["Keys"],
  fields: "sheets(data(rowData(values(formattedValue,hyperlink,textFormatRuns(format(link/uri))))))",
});
const rowData = ks.data.sheets?.[0]?.data?.[0]?.rowData ?? [];
if (!rowData.length) { console.error("[FAIL] empty Keys"); process.exit(1); }
const headerCells = rowData[0]?.values ?? [];
const headers = headerCells.map((c) => String(c?.formattedValue ?? "").replace(/[​-‏‪-‮⁠­﻿]/g, "").replace(/\s+/g, " ").trim());
const iProj = headers.indexOf("פרוייקט");
const iCamp = headers.indexOf("campaign ID");
console.log(`Headers: פרוייקט=${iProj}  campaign ID=${iCamp}\n`);

const ok = [];
const wrong = [];
const missing = [];
for (let r = 1; r < rowData.length; r++) {
  const cells = rowData[r]?.values ?? [];
  const projCell = cells[iProj];
  const campCell = cells[iCamp];
  const proj = String(projCell?.formattedValue ?? "").trim();
  if (!proj) continue;
  const slug = String(campCell?.formattedValue ?? "").trim();
  let url = campCell?.hyperlink ?? "";
  if (!url && campCell?.textFormatRuns) {
    for (const run of campCell.textFormatRuns) {
      const u = run?.format?.link?.uri;
      if (u) { url = u; break; }
    }
  }
  if (!url) {
    missing.push({ row: r + 1, proj, slug });
    continue;
  }
  const gm = url.match(/gid=(\d+)/);
  const gid = gm ? gm[1] : "";
  const tabTitle = gid ? (tabsByGid.get(gid) ?? "(unknown gid)") : "(no gid in link)";
  // Is the linked tab title plausibly the right one for this slug?
  const slugLc = slug.toLowerCase();
  const titleLc = tabTitle.toLowerCase();
  const looksRight =
    slugLc &&
    titleLc &&
    (titleLc === slugLc ||
      titleLc === `${slugLc}crm` ||
      titleLc.startsWith(`${slugLc}_`) ||
      titleLc.startsWith(`${slugLc}-`));
  if (looksRight) ok.push({ row: r + 1, proj, slug, gid, tabTitle });
  else wrong.push({ row: r + 1, proj, slug, gid, tabTitle, url });
}

console.log(`=== ${ok.length} rows OK (linked tab title looks right for slug) ===`);
console.log(`=== ${wrong.length} rows where linked tab title doesn't match campaign ID slug ===`);
for (const w of wrong) {
  console.log(`  row ${w.row}  proj="${w.proj}"  slug="${w.slug}"`);
  console.log(`    linked: gid=${w.gid}  tabTitle="${w.tabTitle}"`);
  // Suggest a target if a tab exists whose title matches the slug.
  const slugLc = w.slug.toLowerCase();
  let suggested = null;
  for (const [gid, title] of tabsByGid.entries()) {
    if (String(title).toLowerCase() === slugLc) { suggested = { gid, title }; break; }
  }
  if (suggested) console.log(`    → SHOULD probably link to gid=${suggested.gid} ("${suggested.title}")`);
}
console.log(`\n=== ${missing.length} rows with no hyperlink set ===`);
for (const m of missing.slice(0, 20)) {
  console.log(`  row ${m.row}  proj="${m.proj}"  slug="${m.slug}"`);
}
if (missing.length > 20) console.log(`  ...and ${missing.length - 20} more.`);
