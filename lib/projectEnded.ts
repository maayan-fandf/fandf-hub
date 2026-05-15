/**
 * Shared helpers for the "hide ended projects" filter.
 *
 * Both the home page (app/page.tsx) and the top-nav projects dropdown
 * (via app/layout.tsx + components/ProjectsNavMenu.tsx) need the same
 * answer for two questions:
 *   1. Which morning-feed scope ("all" / "mine") to fetch with?
 *   2. Is a project considered "ended" given its endIso?
 *
 * Sharing this matters because getMorningFeed is unstable_cache-keyed
 * on (email, scope, project). If the home page and the layout fetched
 * with different scope strings the cache would split into two entries
 * and we'd double the underlying Sheets reads.
 */

import { unstable_cache } from "next/cache";
import { getMorningFeed } from "@/lib/appsScript";

/** Hub admins always see "all" projects. Mirrors the set used in
 *  app/page.tsx + the topnav admin gates. */
const HUB_ADMIN_EMAILS = new Set([
  "maayan@fandf.co.il",
  "nadav@fandf.co.il",
  "felix@fandf.co.il",
]);

/** Decide the morning-feed scope cheaply — without waiting for
 *  getMyProjects. Admins + @fandf.co.il domain users get scope=all;
 *  everyone else gets scope=mine. */
export function morningScopeFor(effectiveEmail: string): "all" | "mine" {
  const lc = effectiveEmail.toLowerCase().trim();
  return HUB_ADMIN_EMAILS.has(lc) || lc.endsWith("@fandf.co.il")
    ? "all"
    : "mine";
}

/** True when the project's endIso (from the morning feed) is more than
 *  5 days in the past — same threshold the home page has always used.
 *  Robust to undefined / malformed date strings. */
export function isProjectEndedByIso(endIso: string | undefined): boolean {
  if (!endIso) return false;
  const end = new Date(endIso + "T00:00:00");
  if (isNaN(end.getTime())) return false;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 5);
  cutoff.setHours(0, 0, 0, 0);
  return end < cutoff;
}

/**
 * Per-user nav-filter data, cached with a thin unstable_cache wrapper.
 *
 * Returns the small slug-keyed maps the top-nav + home grid need to
 * decide which projects to show or hide:
 *   - endIso: project end-date → drives the "ended" filter
 *   - inactive: true when the project has no active campaign this
 *     month → drives the "active campaigns only" filter
 *
 * Why a wrapper instead of calling getMorningFeed directly: the full
 * morning-feed payload can exceed Next.js's 2MB unstable_cache ceiling
 * for admin / scope=all users (~30 projects × heavy per-project blob),
 * which makes the underlying getMorningFeed cache silently fail to
 * store. Without this wrapper, the top-nav dropdown would trigger a
 * fresh Sheets read on every page render for those users.
 *
 * This wrapper extracts only the two slug-keyed maps (a few hundred
 * bytes for 30 projects, well under 2MB) so the cache reliably stores.
 * Same 60s TTL as the underlying feed.
 *
 * Tag-invalidated via "morning-feed" alongside the underlying feed
 * cache, so any future revalidateTag("morning-feed") clears both.
 *
 * "Inactive" heuristic: a project counts as inactive when it has an
 * active (non-dismissed) `paused-budget` signal — this is the Apps
 * Script side's existing notion of "approved budget but no recent
 * spend". Also catches the never-launched case (no budget AND no
 * spend at all) so projects that were configured but never ran
 * stop cluttering the nav. Past-end projects are NOT marked inactive
 * here — the `ended` filter handles those independently so the user
 * can still toggle ended back on without revealing paused-but-current
 * projects too.
 */
export const getProjectNavData = unstable_cache(
  async (
    effectiveEmail: string,
    overrideEmail: string | undefined,
  ): Promise<{
    endIso: Record<string, string>;
    inactive: Record<string, true>;
  }> => {
    const scope = morningScopeFor(effectiveEmail);
    try {
      const morning = await getMorningFeed({ scope, overrideEmail });
      const endIso: Record<string, string> = {};
      const inactive: Record<string, true> = {};
      for (const p of morning.projects) {
        if (p.endIso) endIso[p.name] = p.endIso;
        const hasPausedSignal = p.signals.some(
          (s) => s.kind === "paused-budget" && !s.dismissed,
        );
        const neverRan = p.spend === 0 && p.budget === 0;
        if (hasPausedSignal || neverRan) {
          inactive[p.name] = true;
        }
      }
      return { endIso, inactive };
    } catch {
      // Best-effort — empty maps = nothing hides, the safer default.
      return { endIso: {}, inactive: {} };
    }
  },
  ["projectNavData"],
  { revalidate: 60, tags: ["morning-feed"] },
);

/**
 * Back-compat thin wrapper — older callsites import the endIso map
 * directly. New code should call getProjectNavData() to get both
 * fields in one shot from the same cache entry.
 */
export async function getEndIsoByProject(
  effectiveEmail: string,
  overrideEmail: string | undefined,
): Promise<Record<string, string>> {
  const { endIso } = await getProjectNavData(effectiveEmail, overrideEmail);
  return endIso;
}
