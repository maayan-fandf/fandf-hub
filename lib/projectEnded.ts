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
 * "Inactive" = no current-month media spend. The morning feed's
 * `spend` is summed exclusively from the master tab's `current` rows
 * (see dashboard-clasp getProjectsData ~L1879), so spend > 0 means
 * the project is actively running a budget THIS month and spend === 0
 * means it isn't — which is exactly what "show only running budgets"
 * means. We deliberately do NOT use the `paused-budget` signal here:
 * that only fires for Facebook campaigns explicitly marked PAUSED
 * with a daily budget, so it misses the common cases (campaign
 * deleted, never set up, Google-only paused, budget approved but
 * never spent — e.g. a project carrying an approved budget at ₪0
 * actual). Keying purely off current spend catches all of them.
 *
 * Failure policy — DO NOT swallow-and-cache the empty case here.
 * This used to `try/catch` and return empty maps on any morning-feed
 * error. The trap: this fn is itself unstable_cache-wrapped, so a
 * single transient failure (the morning feed is a ~3.8MB uncacheable
 * read for admins and routinely trips the Sheets read-quota) cached
 * an EMPTY result for the full 60s revalidate window. During that
 * window the top-nav dropdown showed every project unfiltered while
 * the home grid — which fetches the morning feed on its own, separate
 * code path — had already recovered. The two surfaces visibly
 * disagreed (Maayan 2026-05-16: "navbar still shows finished
 * campaigns").
 *
 * Now: a feed error (or a degenerate zero-project feed, which is the
 * shape a quota failure upstream produces) THROWS. unstable_cache
 * does not cache a rejected call, so the next nav render simply
 * retries instead of being pinned to a poisoned empty entry. The
 * fail-open fallback still exists — but at the CALL SITE
 * (layout.tsx's `.catch(() => emptyMaps)`), which means it applies to
 * that one render only and never gets cached. Net effect: the
 * dropdown converges to exactly what the home grid shows.
 *
 * Past-end projects are NOT marked inactive here — the `ended` filter
 * handles those independently.
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
    const morning = await getMorningFeed({ scope, overrideEmail });
    // A zero-project feed is the signature of an upstream failure
    // (quota / timeout returning the empty envelope), not a real
    // "this user has no projects". Throw so it isn't cached as the
    // authoritative answer — see the failure-policy note above.
    if (!morning.projects || morning.projects.length === 0) {
      throw new Error("projectNavData: empty morning feed — not caching");
    }
    const endIso: Record<string, string> = {};
    const inactive: Record<string, true> = {};
    for (const p of morning.projects) {
      if (p.endIso) endIso[p.name] = p.endIso;
      // No current-month spend → not a running budget → inactive.
      if (!(p.spend > 0)) {
        inactive[p.name] = true;
      }
    }
    return { endIso, inactive };
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
