// Discover the Yad2 project URL per real-estate project — best-effort.
// For each project: search Yad2 by name, score every result's visible
// text against the project name, write top-3 candidates to a new
// `YAD2_CANDIDATES` tab on the dashboard-comments spreadsheet for you
// to review.
//
// Why "best-effort": Yad2's text search ranks by keyword frequency, not
// project-name match. Some of our projects don't surface at all from
// the natural-language query of their own name (a listing title like
// "פרויקט חדש בקריית אונו" doesn't share words with "שלישייה על
// הפארק"). The output tab gives you the top-3 candidates + their
// visible text so you can spot the right one in seconds; you paste the
// winner's URL into a new `yad2 url` column in Keys.
//
// Once the column is filled in, scrape-landing-prices.mjs will pick up
// every URL and add Yad2 as a 4th comparison surface in the alert.
//
//   node scripts/discover-yad2-urls.mjs                   # all projects
//   node scripts/discover-yad2-urls.mjs "שלישייה על הפארק" # just one
import { readFileSync } from "node:fs";
import { GoogleAuth } from "google-auth-library";
import { google } from "googleapis";
import puppeteer from "puppeteer";

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
const OUT_TAB = "YAD2_CANDIDATES";
const OUTPUT_SHEET_ID = env.SHEET_ID_COMMENTS;

const auth = new GoogleAuth({
  credentials: JSON.parse(env.TASKS_SA_KEY_JSON),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  clientOptions: { subject: env.DRIVE_FOLDER_OWNER || "maayan@fandf.co.il" },
});
const sh = google.sheets({ version: "v4", auth: await auth.getClient() });

// 1) Project list from Keys.
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
const iCo = kHdr.indexOf("חברה");
const iType = kHdr.findIndex((h) => /project type|סוג פרויקט/i.test(h));

const projects = [];
for (const r of keys.data.values.slice(1)) {
  const project = String(r[iProj] ?? "").trim();
  const slug = String(r[iSlug] ?? "").trim();
  const company = iCo >= 0 ? String(r[iCo] ?? "").trim() : "";
  const type = iType >= 0 ? String(r[iType] ?? "").trim().toLowerCase() : "";
  if (!project) continue;
  if (type && !type.includes("real")) continue;
  if (onlyProject && project !== onlyProject) continue;
  projects.push({ project, slug, company });
}
console.log(`Probing Yad2 for ${projects.length} project(s)…\n`);

// 2) Score how well a candidate Yad2 result matches the project name.
// Hebrew word-overlap: how many of the project's name tokens appear in
// the candidate's visible text. Higher = better. Lengthy / generic
// candidates get penalised because their text contains lots of words
// that aren't actually matches.
function scoreNameOverlap(projectName, candidateText) {
  const STOP = new Set([
    "בית", "פרויקט", "חדש", "ביזם", "דירות", "חד׳", "חד",
    "החל", "מ", "מ-", "מ–", "מ׳", "מיליון", "מהחל", "ל",
  ]);
  const norm = (s) =>
    String(s)
      .toLowerCase()
      .replace(/[^֐-׿a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const a = new Set(norm(projectName).split(/\s+/).filter((w) => w && !STOP.has(w)));
  const b = norm(candidateText).split(/\s+/).filter((w) => w && !STOP.has(w));
  if (a.size === 0) return 0;
  let hits = 0;
  for (const w of b) if (a.has(w)) hits++;
  return hits / a.size;
}

// 3) Puppeteer-driven discovery loop.
const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--lang=he-IL"],
});

const out = [];
for (const p of projects) {
  const url = `https://www.yad2.co.il/realestate/forsale?text=${encodeURIComponent(p.project)}`;
  let candidates = [];
  const startedAt = Date.now();
  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    );
    await page.setExtraHTTPHeaders({ "Accept-Language": "he,en;q=0.8" });
    await page.goto(url, { waitUntil: "networkidle2", timeout: 25_000 });
    await new Promise((r) => setTimeout(r, 1500));
    candidates = await page.evaluate(() => {
      const seen = new Map();
      for (const a of document.querySelectorAll("a[href]")) {
        const href = a.getAttribute("href") || "";
        const m = href.match(/\/yad1\/project\/(?:[a-z-]+\/)?(\d+)/i);
        if (!m) continue;
        const id = m[1];
        const text = (a.textContent || "").trim().slice(0, 200);
        if (!seen.has(id) || text.length > (seen.get(id).text || "").length) {
          seen.set(id, { id, href, text });
        }
      }
      return [...seen.values()];
    });
    await page.close();
  } catch (e) {
    console.log(`  ${p.project} — search error: ${e.message}`);
  }
  const scored = candidates
    .map((c) => ({ ...c, score: scoreNameOverlap(p.project, c.text) }))
    .sort((a, b) => b.score - a.score);
  const top3 = scored.slice(0, 3);
  const best = top3[0];
  const bestUrl = best
    ? `https://www.yad2.co.il/yad1/project/${best.id}`
    : "";
  const confidence =
    !best ? "no-results" :
    best.score >= 0.6 ? "high" :
    best.score >= 0.3 ? "medium" : "low";
  const ms = Date.now() - startedAt;
  console.log(
    `  ${confidence.padEnd(10)} ${p.project.padEnd(28)} → ${bestUrl || "—"}` +
      (best ? `   (score=${best.score.toFixed(2)} "${best.text.slice(0, 40)}")` : "") +
      `   ${ms}ms`,
  );
  out.push({
    slug: p.slug,
    project: p.project,
    company: p.company,
    suggested_url: bestUrl,
    confidence,
    candidate_1: top3[0] ? `[${top3[0].id} · ${top3[0].score.toFixed(2)}] ${top3[0].text}` : "",
    candidate_2: top3[1] ? `[${top3[1].id} · ${top3[1].score.toFixed(2)}] ${top3[1].text}` : "",
    candidate_3: top3[2] ? `[${top3[2].id} · ${top3[2].score.toFixed(2)}] ${top3[2].text}` : "",
    yad2_search_url: url,
  });
}
await browser.close();

// 4) Write candidates tab. (Adds the tab if missing.)
const meta = await sh.spreadsheets.get({
  spreadsheetId: OUTPUT_SHEET_ID,
  fields: "sheets.properties(sheetId,title)",
});
if (!meta.data.sheets?.find((s) => s.properties?.title === OUT_TAB)) {
  await sh.spreadsheets.batchUpdate({
    spreadsheetId: OUTPUT_SHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: OUT_TAB } } }] },
  });
}
const header = [
  "slug",
  "project",
  "company",
  "suggested_url",
  "confidence",
  "candidate_1",
  "candidate_2",
  "candidate_3",
  "yad2_search_url",
];
const values = [header, ...out.map((r) => header.map((c) => r[c] ?? ""))];
await sh.spreadsheets.values.clear({
  spreadsheetId: OUTPUT_SHEET_ID,
  range: OUT_TAB,
});
await sh.spreadsheets.values.update({
  spreadsheetId: OUTPUT_SHEET_ID,
  range: `${OUT_TAB}!A1`,
  valueInputOption: "RAW",
  requestBody: { values },
});

const counts = { high: 0, medium: 0, low: 0, "no-results": 0 };
for (const r of out) counts[r.confidence]++;
console.log(
  `\nWrote ${out.length} rows to ${OUT_TAB}.   ` +
    `high=${counts.high}  medium=${counts.medium}  low=${counts.low}  no-results=${counts["no-results"]}`,
);
