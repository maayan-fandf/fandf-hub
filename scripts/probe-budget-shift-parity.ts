/* eslint-disable */
/**
 * TRUE parity test for lib/budgetShiftSuggestions: extracts the actual
 * scoring/allocation/rebalance functions out of the dashboard's
 * client-dashboard/Index.html, evals them in Node, and runs BOTH
 * engines (iframe JS vs hub TS port) on identical inputs built from
 * live ALL CLIENTS + project-tab data. Reports any divergence in score
 * components, eligibility, deltas, or rationale strings.
 *
 * Run: npx tsx scripts/probe-budget-shift-parity.ts [slug ...]
 */
import fs from "node:fs";
import path from "node:path";
import { google } from "googleapis";
import {
  computeBudgetShiftForProject,
  _computeChannelScoresForProbe,
} from "../lib/budgetShiftSuggestions";
import type { AllClientsRow } from "../lib/allClients";
import type { BudgetProject, BudgetRow } from "../lib/budgetTypes";
import { classifyChannel } from "../lib/budgetTypes";

/* ── load + eval the iframe's engine ────────────────────────────── */
const INDEX_HTML = path.resolve(
  __dirname,
  "../../client-dashboard/Index.html",
);
const html = fs.readFileSync(INDEX_HTML, "utf8");
const start = html.indexOf("function _bayesianShrunk");
const end = html.indexOf("/* ─── Render: balance strip + suggestion panel ─── */");
if (start < 0 || end < 0 || end <= start) {
  console.error("Could not locate the engine block in Index.html");
  process.exit(1);
}
const engineSrc = html.slice(start, end);
// eval in a scope that returns the four entry points.
const iframeEngine = new Function(
  `${engineSrc}
   return { computeChannelScores, computeAllocation, computeRebalance, _suggestionRationale };`,
)() as {
  computeChannelScores: (p: any, summary: any) => any[];
  computeAllocation: (scored: any[], drift: number) => any[];
  computeRebalance: (scored: any[]) => any[];
  _suggestionRationale: (s: any, delta: number) => string;
};
console.log(`(extracted ${engineSrc.length} chars of iframe engine from Index.html)`);

/* ── live data (same readers as probe-budget-shift.ts) ──────────── */
const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
const env = (n: string) =>
  process.env[n] ||
  (envText.split("\n").find((l) => l.startsWith(n + "=")) || "").replace(/^[^=]+=/, "");
const k = JSON.parse(env("TASKS_SA_KEY_JSON"));
const jwt = new google.auth.JWT({
  email: k.client_email,
  key: k.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  subject: "maayan@fandf.co.il",
});
const sheets = google.sheets({ version: "v4", auth: jwt });
const SHEET_ID_MAIN = env("SHEET_ID_MAIN");
const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());
const num = (v: unknown): number => {
  if (v === "" || v == null) return 0;
  const s = typeof v === "number" ? v : Number(String(v).replace(/[₪,\s%]/g, ""));
  return Number.isFinite(s) ? Number(s) : 0;
};
const dateOnlyFromSerial = (v: unknown): string => {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 25000 || v >= 80000) return "";
  return new Date((v - 25569) * 86400 * 1000).toISOString().slice(0, 10);
};

async function readAllClients(): Promise<AllClientsRow[]> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID_MAIN,
    range: "ALL CLIENTS",
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "SERIAL_NUMBER",
  });
  const values = (res.data.values ?? []) as unknown[][];
  const headers = (values[0] || []).map((h) => String(h ?? "").replace(/\s+/g, " ").trim());
  const col = (name: string) => headers.indexOf(name);
  const iStart = col("התחלה"), iEnd = col("סיום"), iChannel = col("מזהה BMBY"),
    iProjId = col('מזהה מע"פ'), iBudget = col("תקציב חודשי מאושר"), iSpend = col("עלות"),
    iLeads = col("לידים CRM"), iScheduled = col("תיאום וביטול"), iMeetings = col("ביצוע פגישות"),
    iDailyRate = col("קצב יומי"), iRowType = col("סוג שורה"), iProject = col("פרוייקט");
  const filled = values.slice(1).map((r) => [...r]);
  let lastProj = "", lastRt = "", lastCh = "";
  for (const row of filled) {
    const proj = String(row[iProject] ?? "").trim() || String(row[iProjId] ?? "").trim();
    const rt = String(row[iRowType] ?? "").trim();
    const ch = String(row[iChannel] ?? "").trim();
    if (proj !== lastProj || rt !== lastRt) { lastProj = proj; lastRt = rt; lastCh = ch; }
    else if (!ch && lastCh) row[iChannel] = lastCh;
    else if (ch) lastCh = ch;
  }
  return filled.map((row) => ({
    rowType: String(row[iRowType] ?? "").trim(),
    project: String(row[iProject] ?? "").trim(),
    projectSlug: String(row[iProjId] ?? "").trim(),
    channel: String(row[iChannel] ?? "").trim(),
    spend: num(row[iSpend]),
    budget: num(row[iBudget]),
    leads: num(row[iLeads]),
    scheduled: num(row[iScheduled]),
    meetings: num(row[iMeetings]),
    dailyRate: iDailyRate >= 0 ? num(row[iDailyRate]) : 0,
    startIso: dateOnlyFromSerial(row[iStart]),
    endIso: dateOnlyFromSerial(row[iEnd]),
  }));
}

function groupBySlugLocal(rows: AllClientsRow[]) {
  // Same consolidation as lib (kept local so the parity test exercises
  // the lib's groupAllClientsBySlug separately if it ever drifts).
  const out = new Map<string, { current: AllClientsRow[]; monthly: AllClientsRow[] }>();
  const byCh = new Map<string, Map<string, AllClientsRow>>();
  for (const r of rows) {
    const slug = r.projectSlug.toLowerCase().trim();
    if (!slug) continue;
    let g = out.get(slug);
    if (!g) { g = { current: [], monthly: [] }; out.set(slug, g); }
    if (r.rowType === "חודשי") { g.monthly.push(r); continue; }
    if (r.rowType !== "current") continue;
    let m = byCh.get(slug);
    if (!m) { m = new Map(); byCh.set(slug, m); }
    const key = r.channel.toLowerCase();
    const ex = m.get(key);
    if (!ex) { const c = { ...r }; m.set(key, c); g.current.push(c); }
    else {
      ex.spend += r.spend; ex.budget += r.budget; ex.leads += r.leads;
      ex.scheduled += r.scheduled; ex.meetings += r.meetings; ex.dailyRate += r.dailyRate;
    }
  }
  return out;
}

async function readProjectTab(slug: string): Promise<BudgetProject | null> {
  let values: unknown[][] = [];
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID_MAIN,
      range: `'${slug.replace(/'/g, "''")}'!A1:J60`,
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "SERIAL_NUMBER",
    });
    values = (res.data.values ?? []) as unknown[][];
  } catch {
    return null;
  }
  const cell = (r: number, c: number) => values[r]?.[c];
  const clean = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();
  const e3 = num(cell(2, 4));
  let headerRow = -1;
  for (let r = 1; r < values.length; r++) {
    if (clean(cell(r, 1)) === "התחלה" && clean(cell(r, 3)) === "מזהה BMBY") { headerRow = r; break; }
  }
  if (headerRow < 0) return null;
  const rows: BudgetRow[] = [];
  let lastChannel = "";
  for (let r = headerRow + 1; r < values.length; r++) {
    const b = clean(cell(r, 1));
    if (b === "total") break;
    let channel = clean(cell(r, 3));
    const budget = num(cell(r, 6));
    const spend = num(cell(r, 7));
    const campaignType = clean(cell(r, 5));
    if (!channel) {
      const hasData = budget !== 0 || spend !== 0 || !!campaignType || !!b || !!clean(cell(r, 2));
      if (lastChannel && hasData) channel = lastChannel;
      else continue;
    }
    lastChannel = channel;
    const endIso = dateOnlyFromSerial(cell(r, 2));
    rows.push({
      row: r + 1, channel, campaignType, platform: classifyChannel(channel),
      budget, spend, pacingRatio: 0, dailyRequired: num(cell(r, 9)),
      endIso, ended: !!endIso && endIso < todayIso, actualDaily: 0, campaignStatus: "none",
    });
  }
  const allocated = rows.filter((r) => r.platform !== "other").reduce((a, r) => a + r.budget, 0);
  return {
    tab: slug, name: slug, company: "", managers: [],
    e3, startIso: "", endIso: "", totalDays: 0, remainingDays: 0, rows,
    platforms: {} as BudgetProject["platforms"], other: {} as BudgetProject["other"],
    allocated, allocatedSpend: 0, delta: allocated - e3,
    reconStatus: "ok", hasActivityTable: true, plan: null,
  };
}

/* ── the diff ───────────────────────────────────────────────────── */
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;
(async () => {
  const allRows = await readAllClients();
  const bySlug = groupBySlugLocal(allRows);
  let slugs = process.argv.slice(2);
  if (slugs[0] === "--all") {
    slugs = [...bySlug.keys()];
  } else if (!slugs.length) {
    slugs = [...bySlug.entries()]
      .map(([slug, g]) => ({ slug, spend: g.current.reduce((a, r) => a + r.spend, 0) }))
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 8)
      .map((x) => x.slug);
  }
  let projectsTested = 0, channelsTested = 0, mismatches = 0;
  for (const slug of slugs) {
    const g = bySlug.get(slug.toLowerCase());
    if (!g || !g.current.length) continue;
    const project = await readProjectTab(slug);
    if (!project) { console.log(`  (skip ${slug}: no tab)`); continue; }
    projectsTested++;

    // iframe inputs
    const p = {
      channels: g.current.map((c) => ({
        channel: c.channel, budget: c.budget, spend: c.spend,
        leads: c.leads, scheduled: c.scheduled, meetings: c.meetings,
        dailyRate: c.dailyRate,
        costPerLead: c.leads > 0 ? c.spend / c.leads : 0,
        costPerScheduled: c.scheduled > 0 ? c.spend / c.scheduled : 0,
        costPerMeeting: c.meetings > 0 ? c.spend / c.meetings : 0,
        subCampaigns: [],
      })),
      monthlyRaw: g.monthly.map((r) => ({
        month: r.startIso.slice(0, 7), channel: r.channel,
        spend: r.spend, leads: r.leads, scheduled: r.scheduled, meetings: r.meetings,
      })),
    };
    const summary = {
      e3: project.e3, delta: project.delta, allocated: project.allocated,
      channels: project.rows.map((r) => ({
        channel: r.channel, platform: r.platform,
        budget: r.budget, spend: r.spend, pacingRatio: r.pacingRatio, ended: r.ended,
      })),
    };

    const jsScored = iframeEngine.computeChannelScores(p, summary);
    const tsScored = _computeChannelScoresForProbe(project, g.current, g.monthly, todayIso);

    // per-channel component diff
    for (let i = 0; i < Math.max(jsScored.length, tsScored.length); i++) {
      const a = jsScored[i], b = tsScored[i];
      channelsTested++;
      if (!a || !b || a.channel !== b.channel) {
        mismatches++;
        console.log(`✗ ${slug}: row ${i} channel mismatch (${a?.channel} vs ${b?.channel})`);
        continue;
      }
      const fields = ["score", "cplScore", "cpsScore", "convScore", "headroomRaw", "trendScore", "trailingLeads", "currentBudget", "currentSpend", "cpl"] as const;
      for (const f of fields) {
        if (!close(Number(a[f]) || 0, Number((b as any)[f]) || 0)) {
          mismatches++;
          console.log(`✗ ${slug}/${a.channel}: ${f} js=${a[f]} ts=${(b as any)[f]}`);
        }
      }
      if (!!a.eligible !== b.eligible) {
        mismatches++;
        console.log(`✗ ${slug}/${a.channel}: eligible js=${!!a.eligible} ts=${b.eligible}`);
      }
      if (String(a.platform) !== String(b.platform)) {
        mismatches++;
        console.log(`✗ ${slug}/${a.channel}: platform js=${a.platform} ts=${b.platform}`);
      }
    }

    // suggestion diff (mode + per-channel delta + reason)
    const driftAbs = Math.abs(project.delta || 0);
    const jsDrift = driftAbs >= 100 ? iframeEngine.computeAllocation(jsScored, project.delta) : [];
    const jsRebal = !jsDrift.length ? iframeEngine.computeRebalance(jsScored) : [];
    const jsMode = jsDrift.length ? "drift" : jsRebal.length ? "rebalance" : "none";
    const jsSugg = jsDrift.length ? jsDrift : jsRebal;
    const tsShift = computeBudgetShiftForProject({
      project, currentRows: g.current, monthlyRows: g.monthly, todayIso,
    });
    const tsMode = tsShift ? tsShift.mode : "none";
    if (jsMode !== tsMode) {
      mismatches++;
      console.log(`✗ ${slug}: mode js=${jsMode} ts=${tsMode}`);
    } else if (jsMode !== "none" && tsShift) {
      if (jsSugg.length !== tsShift.suggestions.length) {
        mismatches++;
        console.log(`✗ ${slug}: suggestion count js=${jsSugg.length} ts=${tsShift.suggestions.length}`);
      } else {
        for (let i = 0; i < jsSugg.length; i++) {
          const ja = jsSugg[i], tb = tsShift.suggestions[i];
          const jReason = ja.fallback
            ? (ja.delta < 0
                ? "הערוץ הכי פחות חזק מבין הפרוגרמטיים — להפחית כדי לסגור את הפער"
                : "הערוץ החזק ביותר מבין הפרוגרמטיים — להגדיל כדי לסגור את הפער")
            : iframeEngine._suggestionRationale(ja.scoreRow, ja.delta);
          if (ja.scoreRow.channel !== tb.channel || ja.delta !== tb.delta || jReason !== tb.reason) {
            mismatches++;
            console.log(`✗ ${slug}: suggestion ${i} js=(${ja.scoreRow.channel}, ${ja.delta}, "${jReason}") ts=(${tb.channel}, ${tb.delta}, "${tb.reason}")`);
          }
        }
      }
    }
    // Correctness check (not just parity): no CUT may land newBudget below
    // the channel's already-incurred spend (the ₪100-floor clamp).
    if (tsShift) {
      const spendByCh: Record<string, number> = {};
      for (const r of project.rows) {
        const k = r.channel.toLowerCase().trim();
        spendByCh[k] = (spendByCh[k] || 0) + r.spend;
      }
      for (const sg of tsShift.suggestions) {
        if (sg.delta >= 0) continue;
        const sp = spendByCh[sg.channel.toLowerCase().trim()] || 0;
        if (sg.newBudget < sp - 0.5) {
          mismatches++;
          console.log(`✗ ${slug}: BELOW-SPEND ${sg.channel} newBudget=₪${sg.newBudget} < spend=₪${Math.round(sp)}`);
        }
      }
    }
    console.log(`✓ ${slug}: ${tsScored.length} channels, mode=${tsMode}${tsShift ? ` totalMove=₪${tsShift.totalMove}` : ""}`);
  }
  console.log(`\n${projectsTested} projects, ${channelsTested} channel rows compared — ${mismatches === 0 ? "FULL PARITY ✅" : `${mismatches} MISMATCHES ❌`}`);
  process.exit(mismatches === 0 ? 0 : 1);
})();
