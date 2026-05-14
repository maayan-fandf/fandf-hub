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
 * Per-user `{ projectName → endIso }` map, cached with a thin
 * unstable_cache wrapper.
 *
 * Why a wrapper instead of calling getMorningFeed directly: the full
 * morning-feed payload can exceed Next.js's 2MB unstable_cache ceiling
 * for admin / scope=all users (~30 projects × heavy per-project blob),
 * which makes the underlying getMorningFeed cache silently fail to
 * store. Without this wrapper, the top-nav dropdown would trigger a
 * fresh Sheets read on every page render for those users.
 *
 * This wrapper extracts only `{name: endIso}` (a few hundred bytes for
 * 30 projects, well under 2MB) so the cache reliably stores. Same
 * 60s TTL as the underlying feed — staleness on "is this project
 * ended" is fine to the day.
 *
 * Tag-invalidated via "morning-feed" alongside the underlying feed
 * cache, so any future revalidateTag("morning-feed") clears both.
 */
export const getEndIsoByProject = unstable_cache(
  async (
    effectiveEmail: string,
    overrideEmail: string | undefined,
  ): Promise<Record<string, string>> => {
    const scope = morningScopeFor(effectiveEmail);
    try {
      const morning = await getMorningFeed({ scope, overrideEmail });
      const out: Record<string, string> = {};
      for (const p of morning.projects) {
        if (p.endIso) out[p.name] = p.endIso;
      }
      return out;
    } catch {
      // Best-effort — empty map = nothing hides, the safer default.
      return {};
    }
  },
  ["endIsoByProject"],
  { revalidate: 60, tags: ["morning-feed"] },
);
