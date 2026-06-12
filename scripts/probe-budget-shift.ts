/* eslint-disable */
/**
 * Read-only parity probe for the budget-shift suggestions
 * (lib/budgetShiftSuggestions — port of the dashboard iframe's
 * reallocation engine). Prints, per project: the scored channel table
 * (leads / trailing / CPL / score components / eligibility) and the
 * suggestion list with deltas + Hebrew rationale — for diffing against
 * the live iframe's הצעת התאמה panel on the same project.
 *
 * Run: npx tsx scripts/probe-budget-shift.ts [slug ...]
 * (tsx resolves the @/lib tsconfig paths; default = 3 busiest projects)
 */
import { google } from "googleapis";
import fs from "node:fs";
import {
  computeBudgetShiftForProject,
  groupAllClientsBySlug,
  _computeChannelScoresForProbe,
} from "../lib/budgetShiftSuggestions";
import type { AllClientsRow } from "../lib/allClients";
import type { BudgetProject, BudgetRow } from "../lib/budgetTypes";
import { classifyChannel } from "../lib/budgetTypes";

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
  // Forward-fill channel within (project,row-type) groups — same as lib/allClients.
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

/** Project-tab read replicating lib/budgetMaster.ts fetchBudgetMaster:
 *  E3 at (2,4); activity-table header row detected by B="התחלה" +
 *  D="מזהה BMBY"; rows below until B="total"; channel col D (3) with
 *  forward-fill across merged cells; budget col G (6), spend col H (7),
 *  end date col C (2), daily col J (9). */
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
  } catch (e) {
    console.log(`  !! tab "${slug}" unreadable: ${(e as Error).message}`);
    return null;
  }
  const cell = (r: number, c: number) => values[r]?.[c];
  const clean = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();
  const e3 = num(cell(2, 4)); // E3
  let headerRow = -1;
  for (let r = 1; r < values.length; r++) {
    if (clean(cell(r, 1)) === "התחלה" && clean(cell(r, 3)) === "מזהה BMBY") {
      headerRow = r;
      break;
    }
  }
  if (headerRow < 0) {
    console.log(`  !! activity-table header not found on tab "${slug}"`);
    return null;
  }
  const rows: BudgetRow[] = [];
  let lastChannel = "";
  for (let r = headerRow + 1; r < values.length; r++) {
    const b = clean(cell(r, 1));
    if (b === "total") break;
    let channel = clean(cell(r, 3)); // D — מזהה BMBY
    const budget = num(cell(r, 6)); // G
    const spend = num(cell(r, 7)); // H
    const campaignType = clean(cell(r, 5)); // F
    if (!channel) {
      const hasData =
        budget !== 0 || spend !== 0 || !!campaignType || !!b || !!clean(cell(r, 2));
      if (lastChannel && hasData) channel = lastChannel;
      else continue;
    }
    lastChannel = channel;
    const endIso = dateOnlyFromSerial(cell(r, 2)); // C
    rows.push({
      row: r + 1,
      channel,
      campaignType,
      platform: classifyChannel(channel),
      budget,
      spend,
      pacingRatio: 0,
      dailyRequired: num(cell(r, 9)),
      endIso,
      ended: !!endIso && endIso < todayIso,
      actualDaily: 0,
      campaignStatus: "none",
    });
  }
  const allocated = rows
    .filter((r) => r.platform !== "other")
    .reduce((a, r) => a + r.budget, 0);
  return {
    tab: slug, name: slug, company: "", managers: [],
    e3, startIso: "", endIso: "", totalDays: 0, remainingDays: 0,
    rows,
    platforms: {} as BudgetProject["platforms"], other: {} as BudgetProject["other"],
    allocated, allocatedSpend: 0,
    delta: allocated - e3,
    reconStatus: e3 <= 0 ? "no-target" : Math.abs(allocated - e3) < 1 ? "ok" : allocated > e3 ? "over" : "under",
    hasActivityTable: true, plan: null,
  };
}

const fmtN = (v: number) => (Math.round(v * 100) / 100).toLocaleString("en-US");
(async () => {
  const allRows = await readAllClients();
  const bySlug = groupAllClientsBySlug(allRows);
  let slugs = process.argv.slice(2);
  if (!slugs.length) {
    slugs = [...bySlug.entries()]
      .map(([slug, g]) => ({ slug, spend: g.current.reduce((a, r) => a + r.spend, 0) }))
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 3)
      .map((x) => x.slug);
    console.log(`(no slugs passed — using 3 busiest: ${slugs.join(", ")})`);
  }
  for (const slug of slugs) {
    console.log(`\n══════ ${slug} ══════`);
    const g = bySlug.get(slug.toLowerCase());
    if (!g) { console.log("  no ALL CLIENTS rows"); continue; }
    const project = await readProjectTab(slug);
    if (!project) continue;
    console.log(`  E3=${fmtN(project.e3)}  allocated=${fmtN(project.allocated)}  delta=${fmtN(project.delta)}`);
    const scored = _computeChannelScoresForProbe(project, g.current, g.monthly, todayIso);
    console.log("  channel                    | leads trail |    cpl |    cps | score (cpl/cps/conv/head/trend) | elig");
    for (const s of scored) {
      console.log(
        `  ${s.channel.padEnd(26).slice(0, 26)} | ${String(s.leads).padStart(5)} ${String(s.trailingLeads).padStart(5)} | ${fmtN(s.cpl).padStart(6)} | ${fmtN(s.cps).padStart(6)} | ${fmtN(s.score).padStart(6)} (${fmtN(s.cplScore)}/${fmtN(s.cpsScore)}/${fmtN(s.convScore)}/${fmtN(s.headroomRaw)}/${fmtN(s.trendScore)}) | ${s.eligible ? "✓" : "✗"} ${s.platform}`,
      );
    }
    const shift = computeBudgetShiftForProject({
      project, currentRows: g.current, monthlyRows: g.monthly, todayIso,
    });
    if (!shift) { console.log("  → no suggestions"); continue; }
    console.log(`  → mode=${shift.mode} totalMove=₪${fmtN(shift.totalMove)}`);
    for (const sg of shift.suggestions) {
      console.log(
        `    ${sg.delta > 0 ? "↑" : "↓"} ${sg.channel}: ₪${fmtN(sg.currentBudget)} → ₪${fmtN(sg.newBudget)} (${sg.delta > 0 ? "+" : ""}${fmtN(sg.delta)})${sg.fallback ? " [fallback]" : ""}`,
      );
      console.log(`      ${sg.reason}`);
    }
  }
})();
