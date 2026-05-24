/* eslint-disable */
/** Simulate computeSalesforceFunnel for the 2 Keys projects. Read-only. */
import { google } from "googleapis";
import fs from "node:fs";

const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
const env = (n) => process.env[n] || (envText.split("\n").find((l) => l.startsWith(n + "=")) || "").replace(/^[^=]+=/, "");
const k = JSON.parse(env("TASKS_SA_KEY_JSON"));
function jwt(scopes, subject = "maayan@fandf.co.il") {
  return new google.auth.JWT({ email: k.client_email, key: k.private_key, scopes, subject });
}
const SHEET_ID_CRM = process.env.CRM_SHEET_ID || "1tYtnB1Ve8RcsZ9_PpRuZyE0jlhD6r-Q35yLO5_7FhEQ";
const sheets = google.sheets({ version: "v4", auth: jwt(["https://www.googleapis.com/auth/spreadsheets"]) });

const SCHEDULED = new Set(["ניסיון תיאום פגישה", "טופס הרשמה", "פגישה התקיימה"]);
const HELD = new Set(["טופס הרשמה", "פגישה התקיימה"]);
const EARLY = new Set(["חדש", "ניסיון יצירת קשר", "אין מענה"]);
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

const res = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID_CRM, range: `Salesforce!A:P`,
  valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "FORMATTED_STRING",
});
const rows = res.data.values || [];
const hdr = (rows[0] || []).map((h) => String(h ?? "").replace(/\s+/g, " ").trim());
const iProject = hdr.findIndex((h) => h.startsWith("פרויקט"));
const iEntry = hdr.findIndex((h) => h.startsWith("תאריך יצירה"));
const iStatus = hdr.indexOf("מצב ליד");
const iSource = hdr.indexOf("מקור ליד");

const projects = [
  { name: "Essence", crm: "בית צורי 22,24" },
  { name: "שיכון ובינוי חולון", crm: "חולון רחוב גולומב- טרום עסקה" },
];
const monthFilter = "2026-05";
const nowMs = Date.now();

for (const p of projects) {
  const target = norm(p.crm);
  let leads = 0, scheduled = 0, held = 0, contacted = 0, stale = 0;
  const byStatus = new Map();
  for (let r = 1; r < rows.length; r++) {
    const arr = rows[r] || [];
    if (norm(arr[iProject]) !== target) continue;
    const st = String(arr[iStatus] ?? "").trim();
    const d = String(arr[iEntry] ?? "").slice(0, 10);
    if (st && EARLY.has(st) && d) {
      const ms = Date.parse(d + "T00:00:00");
      if (!Number.isNaN(ms) && nowMs - ms > 14 * 86400_000) stale++;
    }
    if (monthFilter && d && !d.startsWith(monthFilter)) continue;
    leads++;
    if (SCHEDULED.has(st)) scheduled++;
    if (HELD.has(st)) held++;
    if (st && st !== "חדש") contacted++;
    if (st) byStatus.set(st, (byStatus.get(st) || 0) + 1);
  }
  console.log(`\n=== ${p.name}  (CRM="${p.crm}") month=${monthFilter} ===`);
  console.log(`  לידים=${leads}  נוצר קשר=${contacted}  תואמה פגישה=${scheduled}  פגישות=${held}  יחס פגישה=${leads ? ((held / leads) * 100).toFixed(1) + "%" : "—"}`);
  console.log(`  stale (early-stage >14d, all-time)=${stale}`);
  console.log(`  status breakdown:`);
  for (const [s, c] of [...byStatus.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`     ${String(c).padStart(4)}  ${s}`);
}
