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
// Yad2 source — two-mode resolution. The user used to paste raw Yad2
// URLs into Keys; as of 2026-06-07 they switched to a "yad2lookup"
// column that holds the project's name as it appears in the Yad2-
// provided affiliate sheet. We read that sheet, build a name→URL
// map (only for rows marked "באוויר" with a real http URL), and
// resolve each project's Yad2 URL through it. Backward-compatible:
// if Keys still has a "Yad2 URL" column (legacy schema), that's
// used as a fallback when no yad2lookup is set or the lookup misses.
const iYad2Direct = (() => {
  const lc = kHdr.map((h) => h.toLowerCase());
  for (const c of ["yad2 url", "yad2", "יד2", "יד 2", "יד2 url"]) {
    const i = lc.indexOf(c);
    if (i >= 0) return i;
  }
  return -1;
})();
const iYad2Lookup = (() => {
  const lc = kHdr.map((h) => h.toLowerCase());
  for (const c of ["yad2lookup", "yad2 lookup"]) {
    const i = lc.indexOf(c);
    if (i >= 0) return i;
  }
  return -1;
})();
// Yad2 affiliate sheet — provided by Yad2's account-management team.
// One row per project across all F&F clients; col C is the project's
// name (the `yad2lookup` field in Keys matches against this), col D
// is the Yad2 page URL, col H gates whether the project is currently
// live ("באוויר" / "לא באוויר" / "בהקפאה"). Frozen / not-live rows
// are skipped — their URL is "-" or absent anyway.
const YAD2_AFFILIATE_SHEET_ID = "1ZpdfJhdYa6aD5iftTsGJuVMLTS9WlzHGZMevq5hrxGU";
const YAD2_AFFILIATE_TAB = "yad2";
const yad2LookupMap = await (async () => {
  if (iYad2Lookup < 0) return null;
  try {
    const r = await sh.spreadsheets.values.get({
      spreadsheetId: YAD2_AFFILIATE_SHEET_ID,
      // Explicit A:Z range — Sheets API rejects bare tab names like
      // "yad2" (interprets them as the A1 cell of an unnamed range).
      range: `${YAD2_AFFILIATE_TAB}!A:Z`,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const rows = r.data.values || [];
    const hdr = rows[0] || [];
    // Tolerant column lookup — Yad2 may rename headers at any point.
    const findCol = (candidates) => {
      const lc = hdr.map((h) => String(h || "").trim().toLowerCase());
      for (const c of candidates) {
        const i = lc.indexOf(c.toLowerCase());
        if (i >= 0) return i;
      }
      return -1;
    };
    const iName = findCol(["פרויקט", "פרוייקט", "project"]); // col C
    const iUrl = findCol(["לינק", "url", "link", "yad2 url"]); // col D
    const iLive = findCol(["באוויר או לא ", "באוויר או לא", "live", "status"]); // col H
    if (iName < 0 || iUrl < 0) {
      console.log(
        `Yad2 affiliate sheet: header mismatch (name=${iName} url=${iUrl}) — falling back to no lookup`,
      );
      return null;
    }
    const map = new Map();
    let liveCount = 0;
    let skippedNotLive = 0;
    let skippedNoUrl = 0;
    for (const row of rows.slice(1)) {
      const name = String(row[iName] || "").trim();
      const url = String(row[iUrl] || "").trim();
      const live = iLive >= 0 ? String(row[iLive] || "").trim() : "באוויר";
      if (!name) continue;
      // "באוויר" = live. Anything else (בהקפאה / לא באוויר / blank)
      // is skipped — frozen/inactive projects typically have a "-"
      // in the URL column too.
      if (live !== "באוויר") { skippedNotLive++; continue; }
      if (!/^https?:\/\//i.test(url)) { skippedNoUrl++; continue; }
      // First match wins if the same name appears twice (unusual).
      if (!map.has(name)) map.set(name, url);
      liveCount++;
    }
    console.log(
      `Yad2 affiliate sheet: ${map.size} live URLs loaded (${liveCount} live rows, ${skippedNotLive} not-live, ${skippedNoUrl} no-url)`,
    );
    return map;
  } catch (e) {
    console.log(`Yad2 affiliate sheet read failed: ${String(e.message || e).slice(0, 200)} — falling back to no lookup`);
    return null;
  }
})();
console.log(
  `Landing col: ${iLanding} ("${iLanding >= 0 ? kHdr[iLanding] : "(missing)"}")  ` +
    `Yad2 mode: ${iYad2Lookup >= 0 ? `lookup col ${iYad2Lookup} ("${kHdr[iYad2Lookup]}")` : `direct col ${iYad2Direct} ("${iYad2Direct >= 0 ? kHdr[iYad2Direct] : "(missing)"}")`}`,
);

const projects = [];
for (const r of keys.data.values.slice(1)) {
  const project = String(r[iProj] ?? "").trim();
  const slug = String(r[iSlug] ?? "").trim();
  const landing = String(r[iLanding] ?? "").trim();
  // Yad2 URL resolution — prefer the lookup path (Keys "yad2lookup"
  // value → Yad2 affiliate sheet's "פרויקט" → "לינק"). When the
  // lookup column is empty, the lookup map is missing, or no name
  // match is found, fall back to the legacy direct-URL column if
  // Keys still has one. Yields "" when no Yad2 source can be
  // resolved — the scraper skips Yad2 cleanly for that project.
  let yad2 = "";
  if (iYad2Lookup >= 0 && yad2LookupMap) {
    const lookupName = String(r[iYad2Lookup] ?? "").trim();
    if (lookupName) {
      yad2 = yad2LookupMap.get(lookupName) || "";
    }
  }
  if (!yad2 && iYad2Direct >= 0) {
    yad2 = String(r[iYad2Direct] ?? "").trim();
  }
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
    /** Full inventory as a JSON string: `[{value,anchored,rooms,
     *  roomsLabel}, …]`. Stored in a new `all_prices_json` /
     *  `yad2_all_prices_json` column so Apps Script's
     *  _resolveProjectPriceCheck_ can expose the campaign-manager
     *  "all advertised prices" view on the project page. The legacy
     *  `all` (pipe-joined values) stays for spot-checking in the
     *  sheet — see scrape-landing-prices.mjs columns list. */
    allJson: "[]",
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
      out.allJson = JSON.stringify(
        all.map((d) => ({
          value: d.value,
          anchored: !!d.anchored,
          rooms: d.rooms ?? null,
          roomsLabel: d.roomsLabel || "",
        })),
      );
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
        // for spot-checking what the table contains. Same payload as
        // the success path so the UI inventory still renders even
        // when the headline pick was suppressed (organic Yad2 still
        // shows per-room rows on the project page).
        out.all = all.map((d) => d.value).join("|");
        out.allJson = JSON.stringify(
          all.map((d) => ({
            value: d.value,
            anchored: !!d.anchored,
            rooms: d.rooms ?? null,
            roomsLabel: d.roomsLabel || "",
          })),
        );
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
    all_prices_json: landing.allJson,
    yad2_url: p.yad2 || "",
    yad2_headline_price: yad2.headline,
    yad2_all_prices: yad2.all,
    yad2_all_prices_json: yad2.allJson,
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
  // Phase 1 of the price-inventory work — full JSON list per surface
  // (`[{value, anchored, rooms, roomsLabel}, …]`) so the project page
  // can render every advertised price + its room label, not just the
  // single "lowest anchored" headline pick. Added 2026-06-05; Apps
  // Script's _loadLandingPricesMap_ reads both columns and falls back
  // to [] when missing (legacy rows pre-dating this addition).
  "all_prices_json",
  "yad2_url",
  "yad2_headline_price",
  "yad2_all_prices",
  "yad2_all_prices_json",
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
