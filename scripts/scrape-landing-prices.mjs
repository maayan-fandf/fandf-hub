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
// Output tab schema (LANDING_PRICES on SHEET_ID_COMMENTS):
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
  classifyYad2Page,
} from "../lib/priceExtractor.ts";

// Env resolution. Two run modes:
//   - Local dev → `.env.local` exists, file values take precedence so
//     a shell `export` doesn't accidentally override the curated file.
//   - Cloud Run job → no `.env.local`; everything comes from process.env
//     (Secret Manager mounts + plain env vars set at deploy time).
const env = (() => {
  const fromProcess = { ...process.env };
  try {
    const fileEnv = Object.fromEntries(
      readFileSync(".env.local", "utf8")
        .split("\n")
        .filter((l) => l.includes("=") && !l.startsWith("#"))
        .map((l) => {
          const [k, ...rest] = l.split("=");
          return [k.trim(), rest.join("=").trim().replace(/^["']|["']$/g, "")];
        }),
    );
    return { ...fromProcess, ...fileEnv };
  } catch {
    return fromProcess;
  }
})();

const onlyProject = (process.argv[2] || "").trim();
const TAB = "LANDING_PRICES";
// Output lives in the ops / dashboard-comments spreadsheet (alongside
// names-to-emails, webhooks, user prefs, etc.) — not the master
// "דוח ביצועים" performance sheet — so the perf sheet stays focused
// on media data. Maayan picked the location 2026-06-03.
const OUTPUT_SHEET_ID = env.SHEET_ID_COMMENTS;
if (!OUTPUT_SHEET_ID) {
  console.error("Missing SHEET_ID_COMMENTS in .env.local");
  process.exit(1);
}

const auth = new GoogleAuth({
  credentials: JSON.parse(env.TASKS_SA_KEY_JSON),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  clientOptions: { subject: env.DRIVE_FOLDER_OWNER || "maayan@fandf.co.il" },
});
const sh = google.sheets({ version: "v4", auth: await auth.getClient() });

// ── 1. Read Keysimp → projects to scrape ─────────────────────────────
// We read from the `Keysimp` tab on the dashboard-comments sheet — a
// mirror of the master sheet's `Keys` tab that Maayan keeps synced via
// IMPORTRANGE/sync. Keeping the scraper's input on the SAME spreadsheet
// it writes to (LANDING_PRICES) means the dedicated scraper PC only
// needs access to ONE sheet ID, not two — `SHEET_ID_MAIN` isn't
// required on the scraper host. (Maayan moved the source 2026-06-03.)
const keys = await sh.spreadsheets.values.get({
  spreadsheetId: OUTPUT_SHEET_ID,
  range: "Keysimp",
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
// Optional second column for the project's Yad2 page URL. Maayan fills
// this in manually per project after looking up the URL via the
// YAD2_CANDIDATES tab (Yad2 auto-discovery hits anti-bot fast). When
// the column doesn't exist or the cell is empty for a project, the
// scraper simply omits the Yad2 price from that project's output.
const iYad2 = (() => {
  const lc = kHdr.map((h) => h.toLowerCase());
  for (const c of ["yad2 url", "yad2", "יד2", "יד 2", "יד2 url"]) {
    const i = lc.indexOf(c);
    if (i >= 0) return i;
  }
  return -1;
})();
console.log(
  `Landing col: ${iLanding} ("${iLanding >= 0 ? kHdr[iLanding] : "(missing)"}")  ` +
    `Yad2 col: ${iYad2} ("${iYad2 >= 0 ? kHdr[iYad2] : "(missing — add to Keys to enable)"}")`,
);

const projects = [];
for (const r of keys.data.values.slice(1)) {
  const project = String(r[iProj] ?? "").trim();
  const slug = String(r[iSlug] ?? "").trim();
  const landing = String(r[iLanding] ?? "").trim();
  const yad2 = iYad2 >= 0 ? String(r[iYad2] ?? "").trim() : "";
  const type = iType >= 0 ? String(r[iType] ?? "").trim().toLowerCase() : "";
  // Skip a row only when both surfaces are missing — having just a Yad2
  // URL (no landing) is a legit case for some projects.
  if (!project || (!landing && !yad2)) continue;
  if (type && !type.includes("real")) continue;
  if (onlyProject && project !== onlyProject) continue;
  projects.push({ project, slug, landing, yad2 });
}
console.log(`Scraping ${projects.length} project(s) at ${new Date().toISOString()}`);

// ── 2. Launch one browser, scrape all pages ─────────────────────────
// `PUPPETEER_EXECUTABLE_PATH` is set in the Cloud Run container's
// Dockerfile to point at the system `chromium` (avoids the ~150MB
// puppeteer-bundled download in the image). Locally it's unset, so
// puppeteer falls back to its own bundled binary.
const browser = await puppeteer.launch({
  headless: "new",
  executablePath: env.PUPPETEER_EXECUTABLE_PATH || undefined,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--lang=he-IL"],
});

// Shared per-URL fetch+extract — used for both the project's landing
// page AND its (optional) Yad2 listing. Returns { headline, all, status,
// notes, pageType } so the caller can keep them in separate columns of
// the row. The `label` param is also a surface hint: "yad2" toggles the
// startingPrice() Yad2 rule (return null when no anchored price — see
// classifyYad2Page docs in lib/priceExtractor.ts), and pageType records
// sponsored/organic/unknown for the LANDING_PRICES schema.
async function scrapeOne(url, label) {
  const out = {
    headline: "",
    all: "",
    status: "ok",
    notes: "",
    pageType: "",
  };
  if (!url) {
    out.status = "skipped";
    return out;
  }
  let page;
  try {
    page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    );
    await page.setExtraHTTPHeaders({ "Accept-Language": "he,en;q=0.8" });
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(url, { waitUntil: "networkidle2", timeout: 25_000 });
    await new Promise((r) => setTimeout(r, 1000));
    const text = htmlToText(await page.content());
    const all = extractPrices(text);
    const isYad2 = label === "yad2";
    if (isYad2) out.pageType = classifyYad2Page(text);
    const headline = startingPrice(text, isYad2 ? { surface: "yad2" } : {});
    if (headline) {
      out.headline = String(headline.value);
      out.all = all.map((d) => d.value).join("|");
    } else {
      // For Yad2 organic pages, surface a clearer status than the
      // generic "no-price" so the morning-feed + project page can
      // explain WHY there's no value to compare (apple-vs-orange
      // structural mismatch, not a scraper miss).
      if (isYad2 && out.pageType === "organic") {
        out.status = "organic-no-anchor";
        out.notes =
          "yad2: organic listing without 'החל מ-' anchor — not comparable to a marketing headline";
        // Keep the all_prices list anyway — surfaces it in the sheet
        // for spot-checking what the table contains.
        out.all = all.map((d) => d.value).join("|");
      } else {
        out.status = "no-price";
        out.notes = `${label}: rendered ok but no price matched`;
      }
    }
  } catch (e) {
    out.status = "fetch-error";
    out.notes = `${label}: ${String(e.message || e).slice(0, 180)}`;
  } finally {
    if (page) await page.close();
  }
  return out;
}

const rows = [];
for (const p of projects) {
  const startedAt = Date.now();
  // Scrape landing + Yad2 sequentially within one project. Same browser
  // session so Yad2's bot detection at least sees a single ~steady IP +
  // human-ish cadence rather than 40 parallel hits.
  const landing = await scrapeOne(p.landing, "landing");
  const yad2 = p.yad2
    ? await scrapeOne(p.yad2, "yad2")
    : { headline: "", all: "", status: "skipped", notes: "", pageType: "" };

  const row = {
    slug: p.slug,
    project: p.project,
    landing_url: p.landing,
    headline_price: landing.headline,
    all_prices: landing.all,
    yad2_url: p.yad2 || "",
    yad2_headline_price: yad2.headline,
    yad2_all_prices: yad2.all,
    yad2_page_type: yad2.pageType,
    scraped_at_iso: new Date().toISOString(),
    status: landing.status === "ok" || yad2.status === "ok" ? "ok" : landing.status,
    notes: [landing.notes, yad2.notes].filter(Boolean).join(" | "),
  };
  const ms = Date.now() - startedAt;
  const fmtPrice = (v) => (v ? "₪" + Number(v).toLocaleString("he-IL") : "—");
  console.log(
    `  ${row.status.padEnd(12)} ${p.project.padEnd(28)} ` +
      `web=${fmtPrice(row.headline_price).padEnd(11)} ` +
      `yad2=${fmtPrice(row.yad2_headline_price).padEnd(11)} ` +
      `(${ms}ms)`,
  );
  rows.push(row);
}

await browser.close();

// ── 3. Write to LANDING_PRICES tab ───────────────────────────────────
// Ensure the tab exists; create it the first time the script runs.
const meta = await sh.spreadsheets.get({
  spreadsheetId: OUTPUT_SHEET_ID,
  fields: "sheets.properties(sheetId,title)",
});
const existing = meta.data.sheets?.find((s) => s.properties?.title === TAB);
if (!existing) {
  console.log(`Creating tab "${TAB}"…`);
  await sh.spreadsheets.batchUpdate({
    spreadsheetId: OUTPUT_SHEET_ID,
    requestBody: {
      requests: [{ addSheet: { properties: { title: TAB } } }],
    },
  });
}

const header = [
  "slug",
  "project",
  "landing_url",
  "headline_price",
  "all_prices",
  "yad2_url",
  "yad2_headline_price",
  "yad2_all_prices",
  // sponsored = developer-paid marketing project page on Yad2 (carries
  // `החל מ-` anchors, comparable to a landing page). organic = generic
  // listing without a headline anchor (per-apartment-type table) —
  // the price-mismatch alert should skip Yad2 in that case to avoid
  // comparing landing's "starting from" against Yad2's smallest unit.
  // unknown = no plausible prices on the page at all. Blank = no Yad2
  // URL configured for this project. See classifyYad2Page() in
  // lib/priceExtractor.ts.
  "yad2_page_type",
  "scraped_at_iso",
  "status",
  "notes",
];

// Two write modes:
//   - Full portfolio scrape (no `onlyProject` filter) → REWRITE the
//     whole tab. Removes stale rows for projects that have rotated out
//     of Keys / Keysimp.
//   - Single-project run (`onlyProject` set, e.g. `node ... "kenko"`)
//     → MERGE: read existing rows, replace only the scraped slugs,
//     leave everything else untouched. Without this, a one-off check
//     on a single project would clobber the other 38 rows. (Hit this
//     2026-06-03 — Maayan asked "where did the data go" after a
//     dry-run wiped the tab. Now safe to spot-check anytime.)
let finalRows;
if (onlyProject) {
  // Read existing rows so we can splice rather than overwrite.
  const existingValues = await sh.spreadsheets.values
    .get({
      spreadsheetId: OUTPUT_SHEET_ID,
      range: TAB,
      valueRenderOption: "UNFORMATTED_VALUE",
    })
    .catch(() => ({ data: { values: [] } }));
  const existing = existingValues.data.values || [];
  // Header strategy: take our canonical `header` as the authoritative
  // schema (so newly-added columns like `yad2_page_type` LAND on every
  // run, not just on full-portfolio rewrites), then map the preserved
  // rows from the SHEET's column order onto OUR column order so the
  // columns line up correctly. Preserved rows whose value is missing
  // (column didn't exist on the prior run) come through as "".
  const existingHeader = existing.length ? existing[0] : header;
  const existingSlugIdx = existingHeader.indexOf("slug");
  const updatedSlugs = new Set(rows.map((r) => String(r.slug).toLowerCase()));
  // Preserve every row whose slug WASN'T scraped this run, reshaping
  // each to OUR canonical column order so any newly-added columns
  // appear as empty in the legacy row and any reordering is corrected.
  const preserved = [];
  for (let i = 1; i < existing.length; i++) {
    const row = existing[i];
    const slug = existingSlugIdx >= 0
      ? String(row[existingSlugIdx] ?? "").toLowerCase().trim()
      : "";
    if (!slug || updatedSlugs.has(slug)) continue;
    const reshaped = header.map((colName) => {
      const idx = existingHeader.indexOf(colName);
      return idx >= 0 ? (row[idx] ?? "") : "";
    });
    preserved.push(reshaped);
  }
  const reshapedNew = rows.map((r) => header.map((c) => r[c] ?? ""));
  finalRows = [header, ...preserved, ...reshapedNew];
} else {
  // Whole-portfolio mode — full rewrite is fine.
  finalRows = [header, ...rows.map((r) => header.map((c) => r[c] ?? ""))];
}

await sh.spreadsheets.values.clear({
  spreadsheetId: OUTPUT_SHEET_ID,
  range: TAB,
});
await sh.spreadsheets.values.update({
  spreadsheetId: OUTPUT_SHEET_ID,
  range: `${TAB}!A1`,
  valueInputOption: "RAW",
  requestBody: { values: finalRows },
});

const okCount = rows.filter((r) => r.status === "ok").length;
const noPriceCount = rows.filter((r) => r.status === "no-price").length;
const errorCount = rows.filter((r) => r.status === "fetch-error").length;
console.log(
  `\nWrote ${rows.length} rows to ${TAB}:  ` +
    `ok=${okCount}  no-price=${noPriceCount}  error=${errorCount}`,
);
