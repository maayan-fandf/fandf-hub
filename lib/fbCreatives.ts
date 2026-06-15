/**
 * Reader for the dashboard's Meta ad data in Google Sheets (env
 * SHEET_ID_CREATIVES — "ארכיון" creatives workbook, Supermetrics-fed). The
 * Supabase meta_* tables only cover one F&F account, so the Sheet is the
 * canonical, all-accounts source. Used to attach per-creative spend (and
 * thus cost-per-lead / scheduled / held) onto the CRM funnel's FB drill.
 *
 * Join key: a CRM FB lead's (utm_campaign, utm_content) maps to the sheet's
 * (Campaign name, Ad name) — verified to match EXACTLY for the lead-bearing
 * campaigns, so scoping spend by the project's campaign set is collision-free
 * even though ad names (e.g. "2026-06-07A") repeat across projects.
 *
 * Server-only (uses lib/sa sheetsClient). CrmFunnelClient imports types only.
 */
import { cache } from "react";
import { sheetsClient } from "@/lib/sa";

const SHEET_ID_CREATIVES =
  process.env.SHEET_ID_CREATIVES || "1q-WFtFLDnltznwYKax2yZ1O-q_VToULWN8-sn-8xXuA";

/** Normalize an ad name / utm_content so both sides of the join line up:
 *  drop the " - video|static|…" format suffix + a few Hebrew qualifier tails,
 *  collapse whitespace. */
export function normAdName(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*[-–]\s*(video|static|image|carousel|וידאו|סטטי)\b.*$/i, "")
    .replace(/\s+(רגילות|וידאו|סטטי)\b.*$/u, "")
    .trim();
}

type FbMetricRow = {
  date: string;
  campaign: string;
  adName: string;
  cost: number;
  impressions: number;
  websiteLeads: number;
};

/** Cached raw read of the facebook-ads-metrics tab (daily per-ad Cost /
 *  Impressions / Website-leads). One read shared across all projects in a
 *  request; [] on any error so the funnel degrades gracefully. */
const readFbAdMetrics = cache(async (subjectEmail: string): Promise<FbMetricRow[]> => {
  try {
    const sheets = sheetsClient(subjectEmail);
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID_CREATIVES,
      range: "facebook-ads-metrics!A:I",
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    });
    const values = (res.data.values ?? []) as unknown[][];
    // Date | Account | Campaign | Ad name | Impressions | Cost | Clicks | Website leads | On-FB leads
    return values.slice(1).map((r) => ({
      date: String(r[0] ?? "").slice(0, 10),
      campaign: String(r[2] ?? "").replace(/\s+/g, " ").trim(),
      adName: normAdName(r[3] as string),
      impressions: Number(r[4]) || 0,
      cost: Number(r[5]) || 0,
      websiteLeads: Number(r[7]) || 0,
    }));
  } catch {
    return [];
  }
});

export type FbAdSpend = { cost: number; impressions: number; websiteLeads: number };

/** Per-(normalized ad name) FB spend for a set of campaigns over
 *  [from, toExcl). Scoped by EXACT campaign name so ad-name collisions across
 *  projects can't leak. Empty map when no campaigns / no window / read failed. */
export async function fbAdSpendByCreative(
  subjectEmail: string,
  campaigns: Set<string>,
  from: string,
  toExcl: string,
): Promise<Map<string, FbAdSpend>> {
  const out = new Map<string, FbAdSpend>();
  if (!campaigns.size || !from || !toExcl) return out;
  const rows = await readFbAdMetrics(subjectEmail);
  for (const r of rows) {
    if (!r.adName || !campaigns.has(r.campaign)) continue;
    if (!(r.date >= from && r.date < toExcl)) continue;
    const cur = out.get(r.adName) || { cost: 0, impressions: 0, websiteLeads: 0 };
    cur.cost += r.cost;
    cur.impressions += r.impressions;
    cur.websiteLeads += r.websiteLeads;
    out.set(r.adName, cur);
  }
  return out;
}
