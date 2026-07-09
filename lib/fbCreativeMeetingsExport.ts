/**
 * Server-side export: per-(project, campaign, ad) and per-(project, audience)
 * CRM meetings (scheduled/held) for the current month, written to the
 * `fb-creative-meetings` + `fb-audience-meetings` tabs of the creative
 * workbook (SHEET_ID_CREATIVES). The Apps Script report joins these onto its
 * FB creative cards + Ad-Sets strip (option B: the warehouse key stays in the
 * Hub; the report only reads Sheets).
 *
 * This is the production path, invoked by the Cloud Scheduler cron route
 * (/api/cron/fb-creative-meetings). The standalone dev runner
 * scripts/export-fb-creative-meetings.mjs mirrors this logic for manual runs.
 */
import { supabaseRowsAll, supabaseConfigured } from "./supabase";
import { sheetsClient, driveFolderOwner } from "@/lib/sa";
import { normAdName } from "./fbCreatives";

const SHEET_ID_CREATIVES =
  process.env.SHEET_ID_CREATIVES || "1q-WFtFLDnltznwYKax2yZ1O-q_VToULWN8-sn-8xXuA";
const TAB = "fb-creative-meetings";
const AUD_TAB = "fb-audience-meetings";
const KW_TAB = "google-keyword-meetings";

// Strip invisible bidi/zero-width marks (Meta injects U+200E etc. into the
// UTM values) before collapsing whitespace — same rationale as normAdName.
const clean = (s: unknown) =>
  String(s ?? "").replace(/[​-‏‪-‮⁦-⁩⁠­﻿]/g, "").replace(/\s+/g, " ").trim();

function currentMonthIL(): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  return `${p.find((x) => x.type === "year")!.value}-${p.find((x) => x.type === "month")!.value}`;
}

type LeadRow = {
  client_id: string | null;
  channel_key: string | null;
  lead_created_at: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
};
type MeetingRow = {
  client_id: string | null;
  appointment_outcome: string | null;
  meeting_date: string | null;
  appointment_date: string | null;
};

export type CreativeMeeting = { campaign: string; ad: string; leads: number; scheduled: number; held: number };
export type AudienceMeeting = { audience: string; leads: number; scheduled: number; held: number };
export type KeywordMeeting = { keyword: string; leads: number; scheduled: number; held: number };
export type ProjectMeetings = { creative: CreativeMeeting[]; audience: AudienceMeeting[]; keyword: KeywordMeeting[] };

/** Resolve a month "YYYY-MM" → [from, toExcl) in the warehouse date space. */
function monthWindow(mon: string): { from: string; toExcl: string } {
  const from = `${mon}-01`;
  const [y, m] = mon.split("-").map(Number);
  const toExcl =
    m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return { from, toExcl };
}

/**
 * The per-project warehouse join, as PURE COMPUTE (no Sheet I/O).
 *   • leads     = distinct clients with a lead CREATED in the month, grouped
 *     by their own UTM tag.
 *   • scheduled = meeting EVENTS dated IN the month, credited to the group of
 *     the meeting-client's FIRST-touch lead (any lead age) — same event-in-
 *     window definition as the Hub funnel KPIs (owner-verified on רמת אפעל)
 *     and BMBY's period reports (3-tenant sweep 2026-07-09; see
 *     lib/crmData buildFbBreakdown).
 *   • held      = in-month events BMBY-confirmed as held (strictly marked —
 *     no past-due-unmarked estimates; owner decision 2026-07-09).
 */
type Attr = {
  fb: Map<string, { camp: string; ad: string; aud: string }>;
  gs: Map<string, { kw: string }>;
};

/** client → its ORIGINATING lead's group keys — FIRST-TOUCH: a client is
 *  credited to fb (creative/audience) or gs (keyword) ONLY when their FIRST
 *  lead across ALL channels (by lead_id) is that channel, matching BMBY's
 *  single-source model. So a yad2-first client who also clicked an fb ad
 *  doesn't inflate fb's meetings. Month-independent → built once, reused. */
function buildAttr(allLeads: LeadRow[]): Attr {
  const fb = new Map<string, { camp: string; ad: string; aud: string }>();
  const gs = new Map<string, { kw: string }>();
  const seen = new Set<string>();
  for (const l of allLeads) {
    const c = String(l.client_id ?? "");
    if (!c || seen.has(c)) continue;
    seen.add(c); // this client's first (originating) lead
    const ch = String(l.channel_key ?? "");
    if (ch === "fb") {
      fb.set(c, { camp: clean(l.utm_campaign), ad: normAdName(l.utm_content), aud: clean(l.utm_term) });
    } else if (ch === "gs") {
      gs.set(c, { kw: clean(l.utm_term) });
    }
  }
  return { fb, gs };
}

const numericId = (s: string) => /^\d{8,}$/.test(s);

/** Israel-local calendar day of a warehouse timestamptz (PostgREST returns
 *  UTC; the exporter writes fixed +03:00 — a bare slice(0,10) misfiles
 *  00:00-03:00-IL events into the previous day/month). */
function ilDay(ts: string | null | undefined): string {
  const raw = String(ts ?? "");
  if (!raw) return "";
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return raw.slice(0, 10);
  return new Date(ms + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Pure aggregation (no I/O): month leads (distinct clients per group) +
 *  meeting EVENTS dated in the month (per-client tallies), credited via
 *  first-touch attribution. */
function aggregateMeetings(
  monthLeads: LeadRow[],
  attr: Attr,
  jm: MeetingRow[],
  from: string,
  toExcl: string,
): ProjectMeetings {
  // Per-client tallies of meeting events dated IN the month. held = BMBY-
  // confirmed only (no past-due in_process — owner decision 2026-07-09; see
  // lib/crmData buildFbBreakdown).
  const evByClient = new Map<string, { total: number; done: number }>();
  for (const m of jm) {
    const c = String(m.client_id ?? "");
    if (!c) continue;
    const d = String(m.appointment_date || m.meeting_date || "").slice(0, 10);
    if (!d || d < from || d >= toExcl) continue;
    const rec = evByClient.get(c) || { total: 0, done: 0 };
    rec.total++;
    if (m.appointment_outcome === "held") rec.done++;
    evByClient.set(c, rec);
  }

  type Rec = { extra: Record<string, string>; clients: Set<string>; sched: number; held: number };
  const byKey = new Map<string, Rec>();
  const byAud = new Map<string, Rec>();
  const byKw = new Map<string, Rec>();
  const ensure = (map: Map<string, Rec>, key: string, extra: Record<string, string>): Rec => {
    let rec = map.get(key);
    if (!rec) { rec = { extra, clients: new Set(), sched: 0, held: 0 }; map.set(key, rec); }
    return rec;
  };
  // leads — created this month, distinct client per group.
  for (const l of monthLeads) {
    const c = String(l.client_id ?? "");
    if (!c) continue;
    const ch = String(l.channel_key ?? "");
    if (ch === "fb") {
      const camp = clean(l.utm_campaign), ad = normAdName(l.utm_content);
      if (camp && ad && !numericId(camp) && !numericId(ad)) ensure(byKey, camp + "|" + ad, { camp, ad }).clients.add(c);
      const aud = clean(l.utm_term);
      if (aud && !numericId(aud)) ensure(byAud, aud, { aud }).clients.add(c);
    } else if (ch === "gs") {
      const kw = clean(l.utm_term);
      if (kw && !numericId(kw)) ensure(byKw, kw, { kw }).clients.add(c);
    }
  }
  // Meetings — each client's in-month event tallies, credited once per
  // dimension to the group of their FIRST-touch lead.
  for (const [c, ev] of evByClient) {
    const f = attr.fb.get(c);
    if (f && f.camp && f.ad && !numericId(f.camp) && !numericId(f.ad)) {
      const r = ensure(byKey, f.camp + "|" + f.ad, { camp: f.camp, ad: f.ad });
      r.sched += ev.total; r.held += ev.done;
    }
    if (f && f.aud && !numericId(f.aud)) {
      const r = ensure(byAud, f.aud, { aud: f.aud });
      r.sched += ev.total; r.held += ev.done;
    }
    const g = attr.gs.get(c);
    if (g && g.kw && !numericId(g.kw)) {
      const r = ensure(byKw, g.kw, { kw: g.kw });
      r.sched += ev.total; r.held += ev.done;
    }
  }
  return {
    creative: [...byKey.values()].map((r) => ({ campaign: r.extra.camp, ad: r.extra.ad, leads: r.clients.size, scheduled: r.sched, held: r.held })),
    audience: [...byAud.values()].map((r) => ({ audience: r.extra.aud, leads: r.clients.size, scheduled: r.sched, held: r.held })),
    keyword: [...byKw.values()].map((r) => ({ keyword: r.extra.kw, leads: r.clients.size, scheduled: r.sched, held: r.held })),
  };
}

/** A project's FULL lead history (utm + creation date). Serves BOTH the
 *  attribution map AND the per-month leads count (filtered in memory), so a
 *  multi-month window needs one leads fetch, not one per month. */
function fetchAllLeads(projectId: number): Promise<LeadRow[]> {
  return supabaseRowsAll<LeadRow>(
    `v_bmby_leads_bucketed?project_id=eq.${projectId}` +
      `&select=client_id,channel_key,lead_created_at,utm_campaign,utm_content,utm_term&order=lead_id.asc`,
  );
}

/** A project's full journey-meeting history WITH dates (to window per month). */
function fetchMeetings(projectName: string) {
  return supabaseRowsAll<MeetingRow>(
    `v_bmby_journey_meetings?project_he=eq.${encodeURIComponent(projectName)}` +
      `&select=client_id,appointment_outcome,meeting_date,appointment_date&order=meeting_id.asc`,
  );
}

export async function computeProjectMeetings(
  projectName: string,
  projectId: number,
  from: string,
  toExcl: string,
): Promise<ProjectMeetings> {
  const [allLeads, jm] = await Promise.all([fetchAllLeads(projectId), fetchMeetings(projectName)]);
  if (!allLeads.length) return { creative: [], audience: [], keyword: [] };
  const attr = buildAttr(allLeads);
  const monthLeads = allLeads.filter((l) => {
    const d = ilDay(l.lead_created_at);
    return d >= from && d < toExcl;
  });
  return aggregateMeetings(monthLeads, attr, jm, from, toExcl);
}

/**
 * Live per-project read for the report endpoint: resolve the warehouse
 * project_id by (exact) name, then compute one month's meetings. Returns
 * empty arrays (projectId:null) when the name doesn't resolve, so the caller
 * degrades gracefully to no CRM row. Thin wrapper over the multi-month path.
 */
export async function getProjectMeetingsLive(
  projectName: string,
  month?: string,
): Promise<{ month: string; project: string; projectId: number | null } & ProjectMeetings> {
  const mon = month || currentMonthIL();
  const { project, projectId, results } = await getProjectMeetingsLiveMulti(projectName, [mon]);
  const r = results[0] || { month: mon, creative: [], audience: [], keyword: [] };
  return { month: r.month, project, projectId, creative: r.creative, audience: r.audience, keyword: r.keyword };
}

/**
 * Live MULTI-month read for the report endpoint. The report calls this once per
 * render with every month in its window. Resolves the project + fetches the FULL
 * lead history AND meeting history ONCE (both month-independent), then slices
 * each month's cohort + in-window meetings IN MEMORY — so the whole window is
 * ~2 round-trips deep regardless of month count (was one leads query per month).
 */
export async function getProjectMeetingsLiveMulti(
  projectName: string,
  months: string[],
): Promise<{ project: string; projectId: number | null; results: Array<{ month: string } & ProjectMeetings> }> {
  if (!supabaseConfigured()) throw new Error("Supabase not configured");
  const mons = months.length ? months : [currentMonthIL()];
  const found = await supabaseRowsAll<{ project_id: number; project_name: string }>(
    `v_report_v2_bmby_projects?select=project_id,project_name&project_name=eq.${encodeURIComponent(projectName)}&limit=1`,
  );
  if (!found.length) {
    return {
      project: projectName,
      projectId: null,
      results: mons.map((m) => ({ month: m, creative: [], audience: [], keyword: [] })),
    };
  }
  const projectId = found[0].project_id;
  const projName = found[0].project_name;
  // Lead history + meeting history are both month-independent — fetch once,
  // slice per month in memory.
  const [allLeads, jm] = await Promise.all([fetchAllLeads(projectId), fetchMeetings(projName)]);
  const attr = buildAttr(allLeads);
  const results = mons.map((mon) => {
    const { from, toExcl } = monthWindow(mon);
    const monthLeads = allLeads.filter((l) => {
      const d = ilDay(l.lead_created_at);
      return d >= from && d < toExcl;
    });
    return { month: mon, ...aggregateMeetings(monthLeads, attr, jm, from, toExcl) };
  });
  return { project: projName, projectId, results };
}

export async function exportFbCreativeMeetings(
  month?: string,
): Promise<{ month: string; creativeRows: number; audienceRows: number; keywordRows: number }> {
  if (!supabaseConfigured()) throw new Error("Supabase not configured");
  const mon = month || currentMonthIL();
  const from = `${mon}-01`;
  const [y, m] = mon.split("-").map(Number);
  const toExcl =
    m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;

  const projects = await supabaseRowsAll<{ project_id: number; project_name: string }>(
    `v_report_v2_bmby_projects?select=project_id,project_name&order=project_name`,
  );

  const creativeRows: (string | number)[][] = []; // project, campaign, ad, leads, sched, held
  const audRows: (string | number)[][] = []; // project, audience, leads, sched, held
  const kwRows: (string | number)[][] = []; // project, keyword, leads, sched, held

  for (const p of projects) {
    const m = await computeProjectMeetings(p.project_name, p.project_id, from, toExcl);
    for (const r of m.creative) creativeRows.push([p.project_name, r.campaign, r.ad, r.leads, r.scheduled, r.held]);
    for (const r of m.audience) audRows.push([p.project_name, r.audience, r.leads, r.scheduled, r.held]);
    for (const r of m.keyword) kwRows.push([p.project_name, r.keyword, r.leads, r.scheduled, r.held]);
  }

  // ── write both tabs ──
  const sheets = sheetsClient(driveFolderOwner());
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID_CREATIVES,
    fields: "sheets.properties(title)",
  });
  const existing = new Set((meta.data.sheets ?? []).map((s) => s.properties?.title));
  const updatedAt = new Date().toISOString();
  const writeTab = async (tab: string, header: string[], data: (string | number)[][]) => {
    if (!existing.has(tab)) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID_CREATIVES,
        requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] },
      });
    }
    // MERGE by month — the tab is per-creative/-audience meeting HISTORY now.
    // (Was clear+rewrite, which kept only the last run's month, so the report's
    // past-month views — e.g. monthOverride=2026-03 — found nothing to join.)
    // Preserve every row whose `month` ≠ this run's month; replace only `mon`.
    let preserved: (string | number)[][] = [];
    try {
      const cur = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID_CREATIVES,
        range: `'${tab}'!A:Z`,
        valueRenderOption: "UNFORMATTED_VALUE",
      });
      const vals = (cur.data.values ?? []) as (string | number)[][];
      if (vals.length > 1) {
        const exHdr = (vals[0] as unknown[]).map((h) => String(h ?? ""));
        const exMonth = exHdr.indexOf("month");
        for (let i = 1; i < vals.length; i++) {
          const row = vals[i];
          if (exMonth >= 0 && String(row[exMonth] ?? "") === mon) continue;
          // Reshape onto OUR canonical header order so a column add/reorder
          // can't misalign preserved months.
          preserved.push(
            header.map((c) => {
              const idx = exHdr.indexOf(c);
              return idx >= 0 ? ((row[idx] ?? "") as string | number) : "";
            }),
          );
        }
      }
    } catch {
      preserved = [];
    }
    const fresh = data.map((r) => [...r, mon, updatedAt]);
    const values = [header, ...preserved, ...fresh];
    await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID_CREATIVES, range: `'${tab}'!A:Z` });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID_CREATIVES,
      range: `'${tab}'!A1`,
      valueInputOption: "RAW",
      requestBody: { values },
    });
  };
  await writeTab(TAB, ["project", "campaign", "ad_name", "leads", "scheduled", "held", "month", "updated_at"], creativeRows);
  await writeTab(AUD_TAB, ["project", "audience", "leads", "scheduled", "held", "month", "updated_at"], audRows);
  await writeTab(KW_TAB, ["project", "keyword", "leads", "scheduled", "held", "month", "updated_at"], kwRows);

  return { month: mon, creativeRows: creativeRows.length, audienceRows: audRows.length, keywordRows: kwRows.length };
}
