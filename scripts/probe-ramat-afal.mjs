// One-shot diagnostic for the רמת אפעל Yad2 price mismatch.
//
// Pulls the project's row from Keys (landing URL + Yad2 URL) and the
// latest LANDING_PRICES scrape rows, then loads the live Yad2 page in
// puppeteer + runs the current priceExtractor on it. Lays out what the
// extractor sees, what it picked, and what the scrape recorded last
// night — so we can spot WHY the model picked the wrong number.
//
// Usage:  node scripts/probe-ramat-afal.mjs

import { readFileSync } from "node:fs";
import { GoogleAuth } from "google-auth-library";
import { google } from "googleapis";
import puppeteer from "puppeteer";
import {
  extractPrices,
  startingPrice,
  htmlToText,
  classifyYad2Page,
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

const COMMENTS_SHEET_ID = env.SHEET_ID_COMMENTS;
const KEYS_SHEET_ID = env.SHEET_ID_MAIN;
if (!KEYS_SHEET_ID) throw new Error("Missing SHEET_ID_MAIN");
if (!COMMENTS_SHEET_ID) throw new Error("Missing SHEET_ID_COMMENTS");

const saKey = JSON.parse(env.TASKS_SA_KEY_JSON);
const subjectEmail = env.DRIVE_FOLDER_OWNER || "maayan@fandf.co.il";
const auth = new GoogleAuth({
  credentials: saKey,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  clientOptions: { subject: subjectEmail },
});
const sheets = google.sheets({ version: "v4", auth: await auth.getClient() });

const PROJECT = "רמת אפעל";

// ── 1. Pull URLs from Keys ─────────────────────────────────────────
console.log(`── Reading Keys for "${PROJECT}" ─────────────────────────────`);
const keysRes = await sheets.spreadsheets.values.get({
  spreadsheetId: KEYS_SHEET_ID,
  range: "Keys",
  valueRenderOption: "UNFORMATTED_VALUE",
});
const krows = keysRes.data.values ?? [];
const khdr = krows[0] || [];
const norm = (s) =>
  String(s ?? "")
    .replace(/[​-‏‪-‮⁠­﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
const nameIdx = khdr.findIndex(
  (h) => /^פרוייקט|^project$/.test(norm(h)) || norm(h) === "פרויקט",
);
const landingIdx = khdr.findIndex((h) =>
  /landing\s*url|דף\s*נחיתה/.test(norm(h)),
);
const yad2Idx = khdr.findIndex(
  (h) => /yad2|יד\s*2/i.test(norm(h)) && /url|לינק|כתובת|cms|page|index|קישור|^yad2$|^יד\s*2$/i.test(norm(h)) === false
      ? norm(h).includes("yad2") || norm(h).includes("יד 2") || norm(h).includes("יד2")
      : /yad2|יד\s*2/i.test(norm(h)),
);
console.log(
  `  name col=${nameIdx} (${khdr[nameIdx]})  landing col=${landingIdx} (${khdr[landingIdx]})  yad2 col=${yad2Idx} (${khdr[yad2Idx]})`,
);
const row = krows.slice(1).find((r) => String(r[nameIdx] || "").trim() === PROJECT);
if (!row) {
  console.error(`No Keys row matches "${PROJECT}"`);
  process.exit(1);
}
const landingUrl = String(row[landingIdx] || "").trim();
const yad2Url = String(row[yad2Idx] || "").trim();
console.log(`  landing URL: ${landingUrl || "(none)"}`);
console.log(`  yad2 URL   : ${yad2Url || "(none)"}`);

if (!yad2Url) {
  console.error("No Yad2 URL configured for this project in Keys.");
  process.exit(1);
}

// ── 2. Pull last scrape row for this project from LANDING_PRICES ──
console.log(`\n── Last LANDING_PRICES rows for "${PROJECT}" ─────────────────`);
const lpRes = await sheets.spreadsheets.values.get({
  spreadsheetId: COMMENTS_SHEET_ID,
  range: "LANDING_PRICES",
  valueRenderOption: "UNFORMATTED_VALUE",
});
const lpRows = lpRes.data.values ?? [];
const lpHdr = lpRows[0] || [];
const lpProj = lpHdr.findIndex((h) => norm(h) === "project");
const projRows = lpRows
  .slice(1)
  .filter((r) => String(r[lpProj] || "").trim() === PROJECT)
  .slice(-3);
for (const r of projRows) {
  const obj = {};
  lpHdr.forEach((h, i) => (obj[h] = r[i]));
  console.log(
    `  ${obj.timestamp} status=${obj.status} web=${obj.headline_price} yad2=${obj.yad2_headline_price} pageType=${obj.yad2_page_type} all_yad2=${obj.yad2_all_prices}`,
  );
}

// ── 3. Load the Yad2 page in puppeteer + run extractor ─────────────
console.log(`\n── Probing Yad2 URL: ${yad2Url} ──────────────────────────────`);
const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--lang=he-IL"],
});
const page = await browser.newPage();
await page.setUserAgent(
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
);
await page.setExtraHTTPHeaders({ "Accept-Language": "he,en;q=0.8" });
await page.setViewport({ width: 1280, height: 800 });
await page.goto(yad2Url, { waitUntil: "networkidle2", timeout: 45_000 });
await new Promise((r) => setTimeout(r, 3000));
const title = await page.title();
console.log(`  Title: "${title}"`);
const html = await page.content();
const text = htmlToText(html);
console.log(`  html=${html.length}  text=${text.length}`);

console.log("\n  'החל' neighbourhoods (±80 chars):");
const startRe = /החל\s*מ/g;
let m;
let n = 0;
while ((m = startRe.exec(text)) !== null && n < 10) {
  const a = Math.max(0, m.index - 80);
  const b = Math.min(text.length, m.index + 80);
  console.log(`    [@${m.index}] …${text.slice(a, b)}…`);
  n++;
}
if (n === 0) console.log("    (no 'החל' anchor found)");

console.log("\n  'מ-' neighbourhoods (no 'החל' prefix, ±60 chars, sample 6):");
const fromRe = /[^חל]\s*מ\s*[-־]\s*\d/g;
n = 0;
while ((m = fromRe.exec(text)) !== null && n < 6) {
  const a = Math.max(0, m.index - 60);
  const b = Math.min(text.length, m.index + 60);
  console.log(`    [@${m.index}] …${text.slice(a, b)}…`);
  n++;
}

console.log("\n  extractPrices() output (full):");
console.log(JSON.stringify(extractPrices(text), null, 2));

console.log("\n  classifyYad2Page():", classifyYad2Page(text));

console.log("\n  startingPrice(text, {surface:'yad2'}):");
console.log(JSON.stringify(startingPrice(text, { surface: "yad2" }), null, 2));

console.log("\n  startingPrice(text, {} ) — landing-style fallback for compare:");
console.log(JSON.stringify(startingPrice(text), null, 2));

await browser.close();
