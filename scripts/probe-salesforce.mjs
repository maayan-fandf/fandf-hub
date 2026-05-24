/* eslint-disable */
/** Compare month-2026-05 vs project-window funnel for the 2 SF projects. */
import { google } from "googleapis";
import fs from "node:fs";
const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
const env = (n) => process.env[n] || (envText.split("\n").find((l) => l.startsWith(n + "=")) || "").replace(/^[^=]+=/, "");
const k = JSON.parse(env("TASKS_SA_KEY_JSON"));
const jwt = (sc) => new google.auth.JWT({ email: k.client_email, key: k.private_key, scopes: sc, subject: "maayan@fandf.co.il" });
const sheets = google.sheets({ version: "v4", auth: jwt(["https://www.googleapis.com/auth/spreadsheets"]) });
const SHEET_ID_CRM = "1tYtnB1Ve8RcsZ9_PpRuZyE0jlhD6r-Q35yLO5_7FhEQ";

const SCHEDULED = new Set(["ניסיון תיאום פגישה", "טופס הרשמה", "פגישה התקיימה"]);
const HELD = new Set(["טופס הרשמה", "פגישה התקיימה"]);
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

const rows = (await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID_CRM, range: "Salesforce!A:P", valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "FORMATTED_STRING" })).data.values || [];
const hdr = (rows[0] || []).map((h) => String(h ?? "").replace(/\s+/g, " ").trim());
const iProject = hdr.findIndex((h) => h.startsWith("פרויקט"));
const iEntry = hdr.findIndex((h) => h.startsWith("תאריך יצירה"));
const iStatus = hdr.indexOf("מצב ליד");

const projects = [
  { name: "Essence", crm: "בית צורי 22,24" },
  { name: "שיכון ובינוי חולון", crm: "חולון רחוב גולומב- טרום עסקה" },
];
const WIN = { from: "2026-05-17", to: "2026-06-17" };

function run(target, pass) {
  let leads = 0, sched = 0, held = 0, contacted = 0;
  let minD = "", maxD = "";
  for (let r = 1; r < rows.length; r++) {
    const arr = rows[r] || [];
    if (norm(arr[iProject]) !== target) continue;
    const d = String(arr[iEntry] ?? "").slice(0, 10);
    if (!pass(d)) continue;
    leads++;
    const st = String(arr[iStatus] ?? "").trim();
    if (SCHEDULED.has(st)) sched++;
    if (HELD.has(st)) held++;
    if (st && st !== "חדש") contacted++;
    if (d) { if (!minD || d < minD) minD = d; if (!maxD || d > maxD) maxD = d; }
  }
  return { leads, contacted, sched, held, minD, maxD };
}

for (const p of projects) {
  const t = norm(p.crm);
  const month = run(t, (d) => d.startsWith("2026-05"));
  const win = run(t, (d) => d && d >= WIN.from && d <= WIN.to);
  console.log(`\n=== ${p.name} ===`);
  console.log(`  month 2026-05 : leads=${month.leads} contacted=${month.contacted} sched=${month.sched} held=${month.held}  data ${month.minD}→${month.maxD}`);
  console.log(`  window ${WIN.from}→${WIN.to} : leads=${win.leads} contacted=${win.contacted} sched=${win.sched} held=${win.held}  data ${win.minD}→${win.maxD}`);
}
