import { getCrmFunnelForProject, type CrmFunnel } from "@/lib/crmData";
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
  const funnel = await getCrmFunnelForProject({
    company,
    project,
    monthFilter,
  }).catch(() => null);
  if (!funnel || funnel.leads === 0) return null;
  return <CrmFunnelClient funnel={funnel} />;
}

// Re-export so callers (alerts, etc.) keep importing from one place.
export type { CrmFunnel };
