import {
  getCrmFunnelForProject,
  canonicalMediaChannel,
  type CrmFunnel,
} from "@/lib/crmData";
import { getAllClientsCurrentForProject } from "@/lib/allClients";
import { driveFolderOwner } from "@/lib/sa";
import CrmFunnelClient from "./CrmFunnelClient";

/**
 * Server wrapper — fetches the CRM funnel cohort and hands the full
 * payload to the client component. All five views (KPI tiles, status
 * funnel, objections × source matrix, objection pie, trendline) are
 * client-side rendered so the section's master chip filter can
 * re-aggregate every surface against the selected source mix without
 * re-fetching.
 *
 * Returns null when the project has no Keys.CRM mapping or the source
 * tab has zero matches — caller wraps in <Suspense fallback={null}> so
 * projects without CRM data silently collapse.
 */
export default async function CrmFunnelCard({
  company,
  project,
  monthFilter,
}: {
  company: string;
  project: string;
  /** Threaded from the page's `?monthOverride=YYYY-MM` so this card
   *  matches whatever month the dashboard iframe is rendering. Empty
   *  means "no filter — show all rows we have." */
  monthFilter?: string;
}) {
  // Default the cohort to the project's flight-date window (התחלה→סיום
  // from ALL CLIENTS) so the funnel matches the report header's date
  // range. Skipped when an explicit monthFilter is set (the dashboard's
  // month-rewind view takes priority). getAllClientsCurrentForProject is
  // request-cached, so this read is deduped with the alerts section.
  let projectWindow: { from: string; to: string } | undefined;
  // Per-channel media spend over the flight window — the SAME ALL CLIENTS
  // rows we read for the window also carry `spend` per `מזהה BMBY`
  // channel. Canonicalize each to the cost-join key so crmData can
  // attribute it onto the CRM lead sources (the anda model). Flight-window
  // mode only; the month-rewind view (monthFilter) shows the funnel
  // without cost for now.
  let spendByChannel: Record<string, number> | undefined;
  if (!monthFilter) {
    const acRows = await getAllClientsCurrentForProject({
      subjectEmail: driveFolderOwner(),
      project,
    }).catch(() => []);
    let from = "";
    let to = "";
    const spend: Record<string, number> = {};
    for (const r of acRows) {
      if (r.startIso && (!from || r.startIso < from)) from = r.startIso;
      if (r.endIso && (!to || r.endIso > to)) to = r.endIso;
      const ch = canonicalMediaChannel(r.channel);
      if (ch && r.spend) spend[ch] = (spend[ch] || 0) + r.spend;
    }
    if (from && to) projectWindow = { from, to };
    if (Object.keys(spend).length) spendByChannel = spend;
  }

  const funnel = await getCrmFunnelForProject({
    company,
    project,
    monthFilter,
    projectWindow,
    spendByChannel,
  }).catch(() => null);
  if (!funnel || funnel.leads === 0) return null;
  return <CrmFunnelClient funnel={funnel} />;
}

// Re-export so callers (alerts, etc.) keep importing from one place.
export type { CrmFunnel };
