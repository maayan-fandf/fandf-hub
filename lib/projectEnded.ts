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

import { cache } from "react";
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
 * Per-user nav-filter data. Returns the small slug-keyed maps the
 * top-nav dropdown needs to decide which projects to show or hide:
 *   - endIso: project end-date → drives the "ended" filter
 *   - inactive: true when the project has no current-month spend →
 *     drives the "active campaigns only" filter
 *
 * Wrapped in React's per-request `cache()`, NOT `unstable_cache`.
 *
 * Why this is critical (root cause of the 2026-05-16 "navbar still
 * shows old projects" bug): this fn calls getMorningFeed, which is
 * ITSELF unstable_cache-wrapped (fetchMorningFeedCached in
 * lib/appsScript.ts). Next.js does not support invoking one
 * unstable_cache function from inside another — the inner cached read
 * resolves broken/empty within the outer cache's execution scope. So
 * when getProjectNavData was unstable_cache-wrapped, its nested
 * getMorningFeed call returned an empty feed, the zero-project guard
 * threw, layout.tsx's `.catch(() => emptyMaps)` swallowed it, and the
 * dropdown stamped data-ended="0"/data-inactive="0" on EVERY project
 * — permanently, every render, for admins (scope=all). The home grid
 * stayed correctly filtered because it calls getMorningFeed DIRECTLY
 * (top-level, not nested). Proof: in a single request the grid was
 * filtered while the nav was fully unfiltered — not a transient quota
 * failure (that would knock out both, since they share the same
 * fetchMorningFeedCached entry).
 *
 * React `cache()` dedupes within a request without nesting another
 * unstable_cache, so getProjectNavData now runs the IDENTICAL,
 * non-nested getMorningFeed path the home grid uses — the two
 * surfaces can no longer diverge. Cross-request caching is delegated
 * to fetchMorningFeedCached's own 60s unstable_cache (the grid relies
 * on exactly the same thing). On the home page, layout + page resolve
 * the same morning-feed cache key → still one Sheets read per minute.
 * Matches the repo's standing rule: prefer React `cache()` over
 * unstable_cache for App-Hosting multi-instance safety.
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
 * Failure policy: a zero-project feed is the signature of an upstream
 * failure (quota / timeout returning the empty envelope), not a real
 * "this user has no projects". We THROW rather than return empty maps
 * so the call site's fail-open `.catch(() => emptyMaps)` applies to
 * that one render only. Nothing is persisted across requests now, so
 * the next render retries fresh — no poisoned entry is possible.
 *
 * Past-end projects are NOT marked inactive here — the `ended` filter
 * handles those independently.
 */
export const getProjectNavData = cache(
  async (
    effectiveEmail: string,
    overrideEmail: string | undefined,
  ): Promise<{
    endIso: Record<string, string>;
    inactive: Record<string, true>;
  }> => {
    const scope = morningScopeFor(effectiveEmail);
    const morning = await getMorningFeed({ scope, overrideEmail });
    if (!morning.projects || morning.projects.length === 0) {
      throw new Error("projectNavData: empty morning feed");
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
