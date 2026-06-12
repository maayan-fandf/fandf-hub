/* eslint-disable */
/**
 * (a) Categorize every unparseable תאריך רישום shape in מאגר שכל +
 *     מאגר במבי (תאריך כניסה), app-style (FORMATTED_STRING).
 * (b) Verify the proposed dateOnly() fix (accept / as well as -) brings
 *     אפרידר דיור מוגן June leads back to 211 and clears the failures.
 * Read-only. Run: node scripts/probe-dateonly-fix.mjs
 */
import { google } from "googleapis";
import fs from "node:fs";
const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
const env = (n) => process.env[n] || (envText.split("\n").find((l) => l.startsWith(n + "=")) || "").replace(/^[^=]+=/, "");
const k = JSON.parse(env("TASKS_SA_KEY_JSON"));
const jwt = (s, subject = "maayan@fandf.co.il") => new google.auth.JWT({ email: k.client_email, key: k.private_key, scopes: s, subject });
const SHEET_ID_CRM = process.env.CRM_SHEET_ID || "1tYtnB1Ve8RcsZ9_PpRuZyE0jlhD6r-Q35yLO5_7FhEQ";
const sheets = google.sheets({ version: "v4", auth: jwt(["https://www.googleapis.com/auth/spreadsheets"]) });
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const horizonIso = () => new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);

// CURRENT (buggy) dateOnly
function dateOnlyOld(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const m = raw.match(/^(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 25000 && n < 80000) {
    let iso = new Date((n - 25569) * 86400 * 1000).toISOString().slice(0, 10);
    if (iso > horizonIso()) { const [y, mm, dd] = iso.split("-"); if (+dd >= 1 && +dd <= 12 && +mm >= 1 && +mm <= 12) return `${y}-${dd}-${mm}`; }
    return iso;
  }
  return raw.slice(0, 10);
}
// PROPOSED fix: accept both - and / as the dd?mm?yyyy separator
function dateOnlyNew(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const m = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 25000 && n < 80000) {
    let iso = new Date((n - 25569) * 86400 * 1000).toISOString().slice(0, 10);
    if (iso > horizonIso()) { const [y, mm, dd] = iso.split("-"); if (+dd >= 1 && +dd <= 12 && +mm >= 1 && +mm <= 12) return `${y}-${dd}-${mm}`; }
    return iso;
  }
  return raw.slice(0, 10);
}
const isIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

async function scan(range, dateCol, label, account) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID_CRM, range, valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "FORMATTED_STRING",
  });
  const rows = res.data.values || [];
  const sh = (rows[0] || []).map((h) => String(h ?? "").trim());
  const iProj = sh.findIndex((h) => h === "פרויקט" || h.startsWith("פרויקט"));
  const iDate = sh.indexOf(dateCol);
  const shapes = new Map();
  let total = 0, failOld = 0, failNew = 0;
  let juneOld = 0, juneNew = 0, acctRows = 0;
  const prefix = norm(account);
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const raw = row[iDate];
    if (raw == null || raw === "") continue;
    total++;
    const oldR = dateOnlyOld(raw), newR = dateOnlyNew(raw);
    if (!isIso(oldR)) {
      failOld++;
      const shape = String(raw).replace(/\d/g, "9").slice(0, 19);
      shapes.set(shape, (shapes.get(shape) || 0) + 1);
    }
    if (!isIso(newR)) failNew++;
    // account-scoped June check
    const proj = norm(row[iProj]);
    if (proj.startsWith(prefix) && (proj === prefix || proj[prefix.length] === " ")) {
      acctRows++;
      if (dateOnlyOld(raw).startsWith("2026-06")) juneOld++;
      if (dateOnlyNew(raw).startsWith("2026-06")) juneNew++;
    }
  }
  console.log(`\n=== ${label} (${range}) ===`);
  console.log(`  dated rows: ${total}`);
  console.log(`  unparseable by CURRENT dateOnly: ${failOld}`);
  console.log(`  unparseable by FIXED   dateOnly: ${failNew}`);
  console.log(`  distinct failing shapes (9=digit):`, Object.fromEntries([...shapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)));
  if (account) {
    console.log(`  "${account}" rows: ${acctRows}`);
    console.log(`  "${account}" June leads — CURRENT: ${juneOld}  |  FIXED: ${juneNew}`);
  }
}

await scan("מאגר שכל!A:T", "תאריך רישום", "Sehel", "אפרידר דיור מוגן");
await scan("מאגר במבי!A:AA", "תאריך כניסה", "BMBY", "");
