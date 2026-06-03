// Validate the price extractor against real landing pages.
//
// Usage:
//   node scripts/probe-prices.mjs                  # all real-estate projects from Keys
//   node scripts/probe-prices.mjs "אחוזת אפרידר"   # just one
//
// For each project with a landing URL, fetches the page HTML, runs
// the extractor, and prints every detected price + the headline
// "starting from" pick. This is the read-only sanity check — Phase 2
// will wire the same extractor into the morning-feed signal pipeline
// on the Apps Script side (which also has Google + FB ad copy).
import { readFileSync } from "node:fs";
import { GoogleAuth } from "google-auth-library";
import { google } from "googleapis";
import {
  extractPrices,
  startingPrice,
  htmlToText,
} from "../lib/priceExtractor.ts";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => {
      const [k, ...rest] = l.split("=");
      return [k.trim(), rest.join("=").trim().replace(/^["']|["']$/g, "")];
    }),
);

const onlyProject = (process.argv[2] || "").trim();

const auth = new GoogleAuth({
  credentials: JSON.parse(env.TASKS_SA_KEY_JSON),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  clientOptions: { subject: env.DRIVE_FOLDER_OWNER || "maayan@fandf.co.il" },
});
const sh = google.sheets({ version: "v4", auth: await auth.getClient() });

// Read Keys → list projects with a landing URL.
const keys = await sh.spreadsheets.values.get({
  spreadsheetId: env.SHEET_ID_MAIN,
  range: "Keys",
  valueRenderOption: "UNFORMATTED_VALUE",
});
const HEADER_NORMALIZE = /[​-‏‪-‮⁠­﻿]/g;
const kHdr = (keys.data.values[0] || []).map((h) =>
  String(h ?? "").replace(HEADER_NORMALIZE, "").replace(/\s+/g, " ").trim(),
);
const iProj = kHdr.indexOf("פרוייקט");
const iCo = kHdr.indexOf("חברה");
const iType = kHdr.findIndex((h) => /project type|סוג פרויקט/i.test(h));
// Landing URL column has had different names across the spreadsheet's
// life — mirror Code.js's tolerant lookup so this probe finds the
// column wherever it is. First match wins.
const iLanding = (() => {
  const lc = kHdr.map((h) => h.toLowerCase());
  for (const c of [
    "landing url",
    "landing",
    "landing page",
    "url",
    "דף נחיתה",
    "קישור דף נחיתה",
  ]) {
    const i = lc.indexOf(c);
    if (i >= 0) return i;
  }
  return -1;
})();
console.log(`Landing column resolved to index ${iLanding} ("${iLanding >= 0 ? kHdr[iLanding] : "(not found)"}")`);


const projects = [];
for (const r of keys.data.values.slice(1)) {
  const proj = String(r[iProj] ?? "").trim();
  const co = String(r[iCo] ?? "").trim();
  const landing = String(r[iLanding] ?? "").trim();
  const type = iType >= 0 ? String(r[iType] ?? "").trim().toLowerCase() : "";
  if (!proj || !landing) continue;
  // Default empty type → real estate, per project-type gating convention.
  if (type && !type.includes("real")) continue;
  if (onlyProject && proj !== onlyProject) continue;
  projects.push({ project: proj, company: co, landing });
}

console.log(`Probing ${projects.length} project(s) with landing URLs:\n`);

for (const p of projects) {
  console.log(`━━━ ${p.project}  (${p.company}) ━━━`);
  console.log(`  landing: ${p.landing}`);
  let html = "";
  try {
    const res = await fetch(p.landing, {
      headers: {
        // Some landing pages 403 default UA — pretend to be a normal
        // browser. They're publicly accessible anyway.
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept-Language": "he,en;q=0.8",
      },
      redirect: "follow",
    });
    if (!res.ok) {
      console.log(`  ✗ fetch ${res.status} ${res.statusText}`);
      continue;
    }
    html = await res.text();
  } catch (e) {
    console.log(`  ✗ fetch error: ${e.message}`);
    continue;
  }
  const text = htmlToText(html);
  const all = extractPrices(text);
  const start = startingPrice(text);
  if (all.length === 0) {
    console.log(`  · no prices detected`);
    continue;
  }
  console.log(`  detected ${all.length} price(s):`);
  for (const d of all) {
    const marker = start && d.value === start.value ? " ← starting" : "";
    console.log(
      `    ₪${d.value.toLocaleString("he-IL")}   (matched: "${d.matched}")${marker}`,
    );
  }
}

console.log(`\nDone.`);
