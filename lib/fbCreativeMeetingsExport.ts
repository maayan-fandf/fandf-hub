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

const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

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
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
};

export async function exportFbCreativeMeetings(
  month?: string,
): Promise<{ month: string; creativeRows: number; audienceRows: number }> {
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

  for (const p of projects) {
    const leads = await supabaseRowsAll<LeadRow>(
      `v_bmby_leads_bucketed?project_id=eq.${p.project_id}&channel_key=eq.fb` +
        `&lead_created_at=gte.${from}&lead_created_at=lt.${toExcl}` +
        `&select=client_id,utm_campaign,utm_content,utm_term&order=lead_id.asc`,
    );
    if (!leads.length) continue;
    const jm = await supabaseRowsAll<{ client_id: string | null; appointment_outcome: string | null }>(
      `v_bmby_journey_meetings?project_he=eq.${encodeURIComponent(p.project_name)}` +
        `&select=client_id,appointment_outcome&order=meeting_id.asc`,
    );
    const any = new Set<string>();
    const held = new Set<string>();
    for (const x of jm) {
      const c = String(x.client_id ?? "");
      if (!c) continue;
      any.add(c);
      if (x.appointment_outcome === "held") held.add(c);
    }
    type Rec = { extra: Record<string, string>; clients: Set<string>; sched: Set<string>; held: Set<string> };
    const byKey = new Map<string, Rec>();
    const byAud = new Map<string, Rec>();
    const bump = (map: Map<string, Rec>, key: string, extra: Record<string, string>, c: string) => {
      let rec = map.get(key);
      if (!rec) { rec = { extra, clients: new Set(), sched: new Set(), held: new Set() }; map.set(key, rec); }
      if (c) { rec.clients.add(c); if (any.has(c)) rec.sched.add(c); if (held.has(c)) rec.held.add(c); }
    };
    for (const l of leads) {
      const c = String(l.client_id ?? "");
      const camp = clean(l.utm_campaign);
      const ad = normAdName(l.utm_content);
      if (camp && ad && !/^\d{8,}$/.test(camp) && !/^\d{8,}$/.test(ad)) bump(byKey, camp + "|" + ad, { camp, ad }, c);
      const aud = clean(l.utm_term);
      if (aud && !/^\d{8,}$/.test(aud)) bump(byAud, aud, { aud }, c);
    }
    for (const r of byKey.values()) creativeRows.push([p.project_name, r.extra.camp, r.extra.ad, r.clients.size, r.sched.size, r.held.size]);
    for (const r of byAud.values()) audRows.push([p.project_name, r.extra.aud, r.clients.size, r.sched.size, r.held.size]);
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

  return { month: mon, creativeRows: creativeRows.length, audienceRows: audRows.length };
}
