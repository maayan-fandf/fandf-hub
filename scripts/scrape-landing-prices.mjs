// Headless-Chrome scraper for landing-page prices. Renders the page
// (so JS-rendered SPAs work — afridar, gindi, etc.), runs the same
// extractor as lib/priceExtractor.ts, and writes every project's
// detected prices to the master sheet's `LANDING_PRICES` tab.
//
// Designed to run nightly on Maayan's PC via Windows Task Scheduler:
//
//   node scripts/scrape-landing-prices.mjs
//
// The Apps Script morning-feed job reads LANDING_PRICES and compares
// against Facebook ad copy + Google ad copy to emit price-mismatch
// signals — see Code.js for that side.
//
// Why local PC + nightly:
//   - Headless Chromium is too heavy for the hub deploy (~150MB).
//   - Apps Script's UrlFetchApp can't run JS, so SPA pages would be
//     blank from the dashboard's perspective.
//   - Prices on landing pages change very rarely; a nightly snapshot
//     is more than fresh enough for an alert.
//
// Output tab schema (LANDING_PRICES on SHEET_ID_MAIN):
//
//   slug | project | landing_url | scraped_at_iso | headline_price |
//   all_prices | status | notes
//
// where status is "ok" / "no-price" / "fetch-error" so the Apps Script
// side can show useful detail in the alert ("the website couldn't be
// scraped — manually check it").
import { readFileSync } from "node:fs";
import { GoogleAuth } from "google-auth-library";
import { google } from "googleapis";
import puppeteer from "puppeteer";
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
const TAB = "LANDING_PRICES";

const auth = new GoogleAuth({
  credentials: JSON.parse(env.TASKS_SA_KEY_JSON),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  clientOptions: { subject: env.DRIVE_FOLDER_OWNER || "maayan@fandf.co.il" },
});
const sh = google.sheets({ version: "v4", auth: await auth.getClient() });

// ── 1. Read Keys → projects to scrape ────────────────────────────────
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
const iSlug = kHdr.indexOf("campaign ID");
const iType = kHdr.findIndex((h) => /project type|סוג פרויקט/i.test(h));
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

const projects = [];
for (const r of keys.data.values.slice(1)) {
  const project = String(r[iProj] ?? "").trim();
  const slug = String(r[iSlug] ?? "").trim();
  const landing = String(r[iLanding] ?? "").trim();
  const type = iType >= 0 ? String(r[iType] ?? "").trim().toLowerCase() : "";
  if (!project || !landing) continue;
  if (type && !type.includes("real")) continue;
  if (onlyProject && project !== onlyProject) continue;
  projects.push({ project, slug, landing });
}
console.log(`Scraping ${projects.length} project(s) at ${new Date().toISOString()}`);

// ── 2. Launch one browser, scrape all pages ─────────────────────────
const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--lang=he-IL"],
});

const rows = [];
for (const p of projects) {
  const startedAt = Date.now();
  const row = {
    slug: p.slug,
    project: p.project,
    landing_url: p.landing,
    scraped_at_iso: new Date().toISOString(),
    headline_price: "",
    all_prices: "",
    status: "ok",
    notes: "",
  };
  let page;
  try {
    page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    );
    await page.setExtraHTTPHeaders({ "Accept-Language": "he,en;q=0.8" });
    await page.setViewport({ width: 1280, height: 800 });
    // networkidle2 waits for the page to settle (≤2 in-flight requests
    // for 500ms). SPAs typically render the price area by then.
    // 25s ceiling so a slow page doesn't block the whole run.
    await page.goto(p.landing, { waitUntil: "networkidle2", timeout: 25_000 });
    // Some pages set the price via React after networkidle — give the
    // hydration phase one more second to finish populating.
    await new Promise((r) => setTimeout(r, 1000));
    const text = htmlToText(await page.content());
    const all = extractPrices(text);
    const headline = startingPrice(text);
    if (headline) {
      row.headline_price = String(headline.value);
      row.all_prices = all.map((d) => d.value).join("|");
    } else {
      row.status = "no-price";
      row.notes = "the renderer ran fine but no price matched the regex";
    }
  } catch (e) {
    row.status = "fetch-error";
    row.notes = String(e.message || e).slice(0, 200);
  } finally {
    if (page) await page.close();
  }
  const ms = Date.now() - startedAt;
  console.log(
    `  ${row.status.padEnd(12)} ${p.project.padEnd(30)} ` +
      (row.headline_price ? "₪" + Number(row.headline_price).toLocaleString("he-IL") : "—") +
      `   (${ms}ms)`,
  );
  rows.push(row);
}

await browser.close();

// ── 3. Write to LANDING_PRICES tab ───────────────────────────────────
// Ensure the tab exists; create it the first time the script runs.
const meta = await sh.spreadsheets.get({
  spreadsheetId: env.SHEET_ID_MAIN,
  fields: "sheets.properties(sheetId,title)",
});
const existing = meta.data.sheets?.find((s) => s.properties?.title === TAB);
if (!existing) {
  console.log(`Creating tab "${TAB}"…`);
  await sh.spreadsheets.batchUpdate({
    spreadsheetId: env.SHEET_ID_MAIN,
    requestBody: {
      requests: [{ addSheet: { properties: { title: TAB } } }],
    },
  });
}

const header = [
  "slug",
  "project",
  "landing_url",
  "scraped_at_iso",
  "headline_price",
  "all_prices",
  "status",
  "notes",
];
const values = [
  header,
  ...rows.map((r) => header.map((c) => r[c] ?? "")),
];
await sh.spreadsheets.values.clear({
  spreadsheetId: env.SHEET_ID_MAIN,
  range: TAB,
});
await sh.spreadsheets.values.update({
  spreadsheetId: env.SHEET_ID_MAIN,
  range: `${TAB}!A1`,
  valueInputOption: "RAW",
  requestBody: { values },
});

const okCount = rows.filter((r) => r.status === "ok").length;
const noPriceCount = rows.filter((r) => r.status === "no-price").length;
const errorCount = rows.filter((r) => r.status === "fetch-error").length;
console.log(
  `\nWrote ${rows.length} rows to ${TAB}:  ` +
    `ok=${okCount}  no-price=${noPriceCount}  error=${errorCount}`,
);
