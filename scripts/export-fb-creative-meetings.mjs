// Hub → Sheet export: per-(project, campaign, ad name) scheduled/held meetings
// for the current month, written to the creative workbook's
// "fb-creative-meetings" tab so the Apps Script report can join it onto its FB
// creative cards (it has no per-lead CRM data of its own).
//
//   node scripts/export-fb-creative-meetings.mjs            # current month
//   node scripts/export-fb-creative-meetings.mjs 2026-05    # a specific month
//
// Reuses the warehouse meeting logic: a Meta lead (channel_key='fb') is
// scheduled if its client has ANY journey meeting, held if a HELD one. Keyed
// by (campaign = utm_campaign, ad = normAdName(utm_content)) — the same keys
// the report's topAds use. Scheduled/held are counted per DISTINCT CLIENT.
import { readFileSync } from "node:fs";
import { google } from "googleapis";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const [k, ...r] = l.split("="); return [k.trim(), r.join("=").trim().replace(/^["']|["']$/g, "")]; }),
);
const KEY = env.SUPABASE_CRM_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
const SB = (env.SUPABASE_URL || "https://zkuzyxrkqjtramucjhid.supabase.co/rest/v1/").replace(/\/?$/, "/");
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const CREATIVES_SHEET = env.SHEET_ID_CREATIVES || "1q-WFtFLDnltznwYKax2yZ1O-q_VToULWN8-sn-8xXuA";
const TAB = "fb-creative-meetings";
const AUD_TAB = "fb-audience-meetings";

const MONTH = (process.argv[2] || "").trim() || isoMonthIL();
const FROM = `${MONTH}-01`;
const [y, m] = MONTH.split("-").map(Number);
const TO = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
function isoMonthIL() {
  // current month in Asia/Jerusalem
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  return `${p.find(x=>x.type==="year").value}-${p.find(x=>x.type==="month").value}`;
}
// Strip invisible bidi/zero-width marks (Meta injects U+200E etc. into UTM
// values, breaking the join + splitting one creative into rows) — mirrors
// lib/fbCreatives.ts normAdName + lib/fbCreativeMeetingsExport.ts clean.
const clean = (s) => String(s ?? "").replace(/[​-‏‪-‮⁦-⁩⁠­﻿]/g, "").replace(/\s+/g, " ").trim();
const normAd = (s) => clean(s).replace(/\s*[-–]\s*(video|static|image|carousel|וידאו|סטטי)\b.*$/i, "").replace(/\s+(רגילות|וידאו|סטטי)\b.*$/u, "").trim();
async function sb(path) { const r = await fetch(SB + path, { headers: H }); return r.ok ? r.json() : []; }
async function sbAll(path) { const out = []; for (let s = 0; s < 20000; s += 1000) { const r = await fetch(SB + path, { headers: { ...H, Range: `${s}-${s + 999}` } }); if (!r.ok) break; const j = await r.json(); if (!Array.isArray(j) || !j.length) break; out.push(...j); if (j.length < 1000) break; } return out; }

const projects = await sb(`v_report_v2_bmby_projects?select=project_id,project_name&order=project_name`);
console.log(`Exporting FB creative meetings for ${MONTH} across ${projects.length} bmby projects…`);

const rows = []; // [project, campaign, ad_name, leads, scheduled, held]
const audRows = []; // [project, audience, leads, scheduled, held]
for (const p of projects) {
  const leads = await sbAll(`v_bmby_leads_bucketed?project_id=eq.${p.project_id}&channel_key=eq.fb&lead_created_at=gte.${FROM}&lead_created_at=lt.${TO}&select=client_id,utm_campaign,utm_content,utm_term&order=lead_id.asc`);
  if (!leads.length) continue;
  const jm = await sbAll(`v_bmby_journey_meetings?project_he=eq.${encodeURIComponent(p.project_name)}&select=client_id,appointment_outcome&order=meeting_id.asc`);
  const any = new Set(), held = new Set();
  for (const x of jm) { const c = String(x.client_id ?? ""); if (!c) continue; any.add(c); if (x.appointment_outcome === "held") held.add(c); }
  // per (campaign, ad) and per audience(utm_term) → distinct clients + meeting state
  const byKey = new Map(), byAud = new Map();
  const bump = (map, k, fields, c) => {
    if (!map.has(k)) map.set(k, { ...fields, clients: new Set(), sched: new Set(), held: new Set() });
    const rec = map.get(k);
    if (c) { rec.clients.add(c); if (any.has(c)) rec.sched.add(c); if (held.has(c)) rec.held.add(c); }
  };
  for (const l of leads) {
    const c = String(l.client_id ?? "");
    const camp = clean(l.utm_campaign), ad = normAd(l.utm_content);
    if (camp && ad && !/^\d{8,}$/.test(camp) && !/^\d{8,}$/.test(ad)) bump(byKey, camp + "|" + ad, { camp, ad }, c);
    const aud = clean(l.utm_term);
    if (aud && !/^\d{8,}$/.test(aud)) bump(byAud, aud, { aud }, c);
  }
  for (const r of byKey.values()) rows.push([p.project_name, r.camp, r.ad, r.clients.size, r.sched.size, r.held.size]);
  for (const r of byAud.values()) audRows.push([p.project_name, r.aud, r.clients.size, r.sched.size, r.held.size]);
}
console.log(`Computed ${rows.length} (project, campaign, ad) + ${audRows.length} (project, audience) rows with meetings.`);

// ── write to the creative workbook tab ──
const auth = new google.auth.JWT({ email: JSON.parse(env.TASKS_SA_KEY_JSON).client_email, key: JSON.parse(env.TASKS_SA_KEY_JSON).private_key, scopes: ["https://www.googleapis.com/auth/spreadsheets"], subject: env.DRIVE_FOLDER_OWNER || "maayan@fandf.co.il" });
const sheets = google.sheets({ version: "v4", auth });
const meta = await sheets.spreadsheets.get({ spreadsheetId: CREATIVES_SHEET, fields: "sheets.properties(sheetId,title)" });
const existing = new Set(meta.data.sheets.map((s) => s.properties.title));
const updatedAt = new Date().toISOString();
async function writeTab(tab, header, dataRows) {
  if (!existing.has(tab)) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: CREATIVES_SHEET, requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] } });
    console.log(`created tab "${tab}"`);
  }
  // MERGE by month (matches lib/fbCreativeMeetingsExport.ts) — keep other
  // months' rows, replace only MONTH, so backfilling a past month doesn't wipe
  // the rest of the history.
  let preserved = [];
  try {
    const cur = await sheets.spreadsheets.values.get({ spreadsheetId: CREATIVES_SHEET, range: `'${tab}'!A:Z`, valueRenderOption: "UNFORMATTED_VALUE" });
    const vals = cur.data.values || [];
    if (vals.length > 1) {
      const exHdr = vals[0].map((h) => String(h ?? ""));
      const exMonth = exHdr.indexOf("month");
      for (let i = 1; i < vals.length; i++) {
        const row = vals[i];
        if (exMonth >= 0 && String(row[exMonth] ?? "") === MONTH) continue;
        preserved.push(header.map((c) => { const idx = exHdr.indexOf(c); return idx >= 0 ? (row[idx] ?? "") : ""; }));
      }
    }
  } catch { preserved = []; }
  const fresh = dataRows.map((r) => [...r, MONTH, updatedAt]);
  const values = [header, ...preserved, ...fresh];
  await sheets.spreadsheets.values.clear({ spreadsheetId: CREATIVES_SHEET, range: `'${tab}'!A:Z` });
  await sheets.spreadsheets.values.update({ spreadsheetId: CREATIVES_SHEET, range: `'${tab}'!A1`, valueInputOption: "RAW", requestBody: { values } });
  console.log(`✓ wrote ${dataRows.length} rows for ${MONTH} to "${tab}" (+${preserved.length} preserved, updated ${updatedAt})`);
}
await writeTab(TAB, ["project", "campaign", "ad_name", "leads", "scheduled", "held", "month", "updated_at"], rows);
await writeTab(AUD_TAB, ["project", "audience", "leads", "scheduled", "held", "month", "updated_at"], audRows);
// quick peek
const kenko = rows.filter((r) => r[0] === "רעננה קנקו");
console.log(`kenko rows:`); for (const r of kenko) console.log(`   ${r[2].padEnd(14)} leads=${r[3]} sched=${r[4]} held=${r[5]}`);
