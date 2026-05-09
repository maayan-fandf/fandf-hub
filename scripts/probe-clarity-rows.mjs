/* eslint-disable */
// Diagnostic: dump landing URL + Clarity API token for the named projects,
// then call the Clarity Data Export API for each and compare what comes
// back. Used to investigate "two different projects show identical numbers"
// — most likely cause is a shared workspace where the URL filter isn't
// actually scoping the response.
//
// Run: node scripts/probe-clarity-rows.mjs "קאזר" "מרום ראשון"

import { google } from "googleapis";
import fs from "node:fs";

const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
const env = (n) => process.env[n] || (envText.split("\n").find((l) => l.startsWith(n + "=")) || "").replace(/^[^=]+=/, "");

const PROJECTS = process.argv.slice(2).length ? process.argv.slice(2) : ["קאזר", "מרום ראשון"];
const SUBJECT = "maayan@fandf.co.il";

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
const lower = headers.map((h) => h.toLowerCase());
const iProj = headers.indexOf("פרוייקט");

const LANDING_CANDS = ["landing url", "landing", "landing page", "url", "דף נחיתה", "קישור דף נחיתה"];
const TOKEN_CANDS = ["clarity api token", "clarity token", "clarity api key", "clarity key", "clarity api", "clarity", "טוקן קלריטי", "קלריטי"];

const findCol = (cands) => {
  for (const c of cands) {
    const idx = lower.indexOf(c);
    if (idx >= 0) return { idx, header: headers[idx] };
  }
  return { idx: -1, header: null };
};

const landing = findCol(LANDING_CANDS);
const token = findCol(TOKEN_CANDS);
console.log(`Landing column: header="${landing.header}" idx=${landing.idx}`);
console.log(`Token column:   header="${token.header}" idx=${token.idx}`);

const findRow = (target) => {
  const t = target.toLowerCase().trim();
  for (let i = 1; i < rows.length; i++) {
    const name = String(rows[i][iProj] ?? "").toLowerCase().trim();
    if (name === t) return { row: rows[i], i };
  }
  return null;
};

const mask = (s) => (s ? `${s.slice(0, 4)}…${s.slice(-4)} (len=${s.length})` : "(empty)");

const results = [];
for (const p of PROJECTS) {
  const found = findRow(p);
  if (!found) {
    console.log(`\n--- ${p} : NOT FOUND in Keys`);
    continue;
  }
  const url = String(found.row[landing.idx] ?? "").trim();
  const tok = String(found.row[token.idx] ?? "").trim();
  console.log(`\n--- ${p} (row ${found.i})`);
  console.log(`    landingUrl: ${url || "(empty)"}`);
  console.log(`    token:      ${mask(tok)}  suffix=${tok.slice(-8) || "(none)"}`);
  results.push({ project: p, url, token: tok });
}

// Compare tokens across the projects
const tokenSet = new Set(results.map((r) => r.token).filter(Boolean));
console.log(`\nUnique tokens across the queried projects: ${tokenSet.size}`);
if (tokenSet.size === 1 && results.length > 1) {
  console.log("→ All projects share the SAME Clarity API token (= same workspace).");
  console.log("→ With one shared workspace, only the URL filter scopes per-page.");
}

// Now actually hit the Clarity API for each and dump the raw response
console.log("\n=== Clarity API responses ===");
for (const r of results) {
  if (!r.token || !r.url) {
    console.log(`\n[${r.project}] skipped (missing token or url)`);
    continue;
  }
  const params = new URLSearchParams({
    numOfDays: "3",
    dimension1: "URL",
    dimension1Filter: r.url,
  });
  const res = await fetch(`https://www.clarity.ms/export-data/api/v1/project-live-insights?${params}`, {
    headers: { authorization: `Bearer ${r.token}` },
  });
  const body = await res.text();
  console.log(`\n[${r.project}] status=${res.status}`);
  console.log(`  URL filter sent: ${r.url}`);
  let parsed = null;
  try { parsed = JSON.parse(body); } catch {}
  if (parsed && Array.isArray(parsed)) {
    // Sum sessions across the Traffic block to see what we're getting
    const traffic = parsed.find((b) => b?.metricName === "Traffic");
    let sessions = 0;
    if (traffic && Array.isArray(traffic.information)) {
      for (const r of traffic.information) {
        sessions += Number(r?.totalSessionCount ?? r?.sessions ?? 0);
      }
    }
    console.log(`  Traffic.totalSessions: ${sessions}`);
    console.log(`  metric blocks present: ${parsed.map((b) => b?.metricName).join(", ")}`);
  } else {
    console.log(`  body snippet: ${body.slice(0, 400)}`);
  }
}

// Also probe one project WITHOUT the URL filter to compare
const sample = results.find((r) => r.token && r.url);
if (sample) {
  console.log("\n=== Sanity check: same token, NO URL filter ===");
  const res = await fetch(`https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=3`, {
    headers: { authorization: `Bearer ${sample.token}` },
  });
  const body = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(body); } catch {}
  if (parsed && Array.isArray(parsed)) {
    const traffic = parsed.find((b) => b?.metricName === "Traffic");
    let sessions = 0;
    if (traffic && Array.isArray(traffic.information)) {
      for (const r of traffic.information) {
        sessions += Number(r?.totalSessionCount ?? r?.sessions ?? 0);
      }
    }
    console.log(`[${sample.project} unfiltered] Traffic.totalSessions: ${sessions}`);
    console.log(`  → if this matches the filtered call above, the URL filter is NOT scoping`);
  } else {
    console.log(`  body snippet: ${body.slice(0, 400)}`);
  }
}
