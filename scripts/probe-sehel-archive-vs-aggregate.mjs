/* eslint-disable */
/**
 * Compare archive vs aggregate using clientId as the join key — finds
 * archive rows whose clientId is missing from the aggregate.
 *
 * Both tabs have the same shape: row 1 = title preamble (single cell),
 * row 2 = headers, row 3+ = data. clientId is the rightmost column.
 *
 * Adjustments vs v1:
 *   - Skip the title row when reading.
 *   - Reuse the lib's dateOnly semantics (dd-mm-yyyy + Excel serial).
 *   - Project match uses prefix (Sehel rows are "<project> <salesperson>").
 *   - clientId-based diff between archive and aggregate.
 */
import { google } from "googleapis";
import fs from "node:fs";

const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local","utf8") : "";
const env = (n) => process.env[n] || (envText.split("\n").find(l=>l.startsWith(n+"="))||"").replace(/^[^=]+=/,"");
const k = JSON.parse(env("TASKS_SA_KEY_JSON"));
const jwt = new google.auth.JWT({ email:k.client_email, key:k.private_key, scopes:["https://www.googleapis.com/auth/spreadsheets"], subject:"maayan@fandf.co.il" });
const sheets = google.sheets({ version:"v4", auth: jwt });

const SHEET_ID = "1tYtnB1Ve8RcsZ9_PpRuZyE0jlhD6r-Q35yLO5_7FhEQ";
const TAB_ARCHIVE = "ארכיון מאי 26 שכל";
const TAB_AGG = "מאגר שכל";

const norm = (v) => String(v ?? "").replace(/\s+/g, " ").trim();

function dateOnly(value) {
  const raw = norm(value);
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const m = raw.match(/^(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 25000 && n < 80000) {
    return new Date((n - 25569) * 86400 * 1000).toISOString().slice(0, 10);
  }
  return "";
}

async function readTab(title, headerRow, range) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${title}!${range}`,
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  const values = res.data.values ?? [];
  if (!values.length) return { headers: [], rows: [] };
  const headers = (values[headerRow - 1] || []).map(norm);
  const rows = values.slice(headerRow); // skip up to & including header row
  return { headers, rows };
}

console.log("Reading archive tab (header on row 2)…");
const arch = await readTab(TAB_ARCHIVE, 2, "A1:T20000");
console.log(`  ${arch.rows.length} data rows, headers: ${arch.headers.length}`);

console.log("Reading aggregate tab (header on row 1)…");
const agg = await readTab(TAB_AGG, 1, "A1:T30000");
console.log(`  ${agg.rows.length} data rows, headers: ${agg.headers.length}`);
console.log("");

// Verify headers match (skip the leading blank "" col which is row index)
function findCol(headers, name) { return headers.indexOf(name); }

const idA = findCol(arch.headers, "clientId");
const idG = findCol(agg.headers, "clientId");
const dateA = findCol(arch.headers, "תאריך רישום");
const dateG = findCol(agg.headers, "תאריך רישום");
const projA = findCol(arch.headers, "פרויקט");
const projG = findCol(agg.headers, "פרויקט");
console.log(`clientId  cols → archive=${idA}, aggregate=${idG}`);
console.log(`תאריך     cols → archive=${dateA}, aggregate=${dateG}`);
console.log(`פרויקט    cols → archive=${projA}, aggregate=${projG}`);
console.log("");

// ── Build aggregate clientId set ────────────────────────────────────
const aggIds = new Set();
let aggBlank = 0;
for (const row of agg.rows) {
  const id = norm(row[idG]);
  if (!id) { aggBlank++; continue; }
  aggIds.add(id);
}
console.log(`Aggregate clientIds: ${aggIds.size} unique, ${aggBlank} blank.`);

// ── Find archive rows whose clientId is missing from aggregate ──────
const missing = [];
let archBlankId = 0;
for (const row of arch.rows) {
  const id = norm(row[idA]);
  if (!id) { archBlankId++; continue; }
  if (!aggIds.has(id)) {
    missing.push({
      id,
      proj: norm(row[projA]),
      date: dateOnly(row[dateA]),
      raw: row,
    });
  }
}
console.log(`Archive rows: ${arch.rows.length} (${archBlankId} blank-id)`);
console.log(`Archive rows missing from aggregate: ${missing.length}`);
console.log("");

// ── Date histogram of missing rows ────────────────────────────────
const histMissing = new Map();
for (const m of missing) {
  if (!m.date) continue;
  histMissing.set(m.date, (histMissing.get(m.date) || 0) + 1);
}
console.log("Missing-row date histogram:");
const datesSorted = [...histMissing.keys()].sort();
for (const d of datesSorted) {
  console.log(`  ${d}  →  ${histMissing.get(d)}`);
}
console.log("");

// ── Date histogram of ALL archive rows ─────────────────────────────
const histAll = new Map();
for (const row of arch.rows) {
  const d = dateOnly(row[dateA]);
  if (!d) continue;
  histAll.set(d, (histAll.get(d) || 0) + 1);
}
console.log("Archive total-row date histogram:");
const datesAll = [...histAll.keys()].sort();
for (const d of datesAll) {
  console.log(`  ${d}  →  archive=${histAll.get(d)}  missing=${histMissing.get(d) || 0}`);
}
console.log("");

// ── Per-project freshness comparison ────────────────────────────────
function maxByProject(rows, dateI, projI) {
  const m = new Map();
  for (const row of rows) {
    const p = norm(row[projI]);
    const d = dateOnly(row[dateI]);
    if (!p) continue;
    const cur = m.get(p) || { max: "", count: 0 };
    cur.count++;
    if (d && d > cur.max) cur.max = d;
    m.set(p, cur);
  }
  return m;
}
const archProjMax = maxByProject(arch.rows, dateA, projA);
const aggProjMax = maxByProject(agg.rows, dateG, projG);
console.log(`Distinct projects — archive: ${archProjMax.size}, aggregate: ${aggProjMax.size}`);

// ── Focus on gan/ginot ──────────────────────────────────────────────
console.log("");
console.log("Projects matching 'גינות יעקב' / 'גנים יעקב' (case-insensitive substring):");
const focus = [...archProjMax.keys()].filter((p) => p.includes("גינות יעקב") || p.includes("גנים יעקב") || p.includes("גינות") && p.includes("יעקב"));
if (focus.length === 0) {
  console.log("  (no matches in archive — listing all projects containing 'גינות' or 'יעקב')");
  const fuzzy = [...archProjMax.keys()].filter((p) => p.includes("גינות") || p.includes("יעקב"));
  for (const p of fuzzy.slice(0, 30)) console.log(`    "${p}"  (${archProjMax.get(p).count} rows)`);
} else {
  for (const p of focus) {
    const a = archProjMax.get(p);
    const g = aggProjMax.get(p);
    console.log(`  "${p}"`);
    console.log(`    archive  : ${a.count} rows, max date ${a.max}`);
    console.log(`    aggregate: ${g ? g.count : 0} rows, max date ${g?.max || "(none)"}`);
  }
}
