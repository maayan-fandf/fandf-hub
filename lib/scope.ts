import type { Project } from "@/lib/appsScript";

/**
 * Shared person-scope logic. Used by:
 *   - app/page.tsx      — filters the home-page project grid
 *   - app/layout.tsx    — filters the top-nav פרויקטים dropdown (via cookie)
 *   - app/inbox/page.tsx, app/morning/page.tsx, app/projects/[project]/page.tsx
 *
 * This module is client-safe (no `next/headers`) so client components like
 * OutOfScopeBanner can import `SCOPE_PERSON_COOKIE` from here. Server-only
 * helpers that read request cookies live in `lib/scope-server.ts`.
 *
 * "Is `person` on project `p`?" — searches every roster slot (media manager,
 * project manager, internal team, client-facing) for a case-insensitive match
 * on the person's full display name.
 */
export function isPersonOnProject(p: Project, person: string): boolean {
  if (!person) return false;
  const target = person.toLowerCase();
  const r = p.roster;
  if (r.mediaManager && r.mediaManager.toLowerCase() === target) return true;
  if (r.projectManagerFull && r.projectManagerFull.toLowerCase() === target)
    return true;
  if (r.internalOnly.some((n) => n.toLowerCase() === target)) return true;
  if (r.clientFacing.some((n) => n.toLowerCase() === target)) return true;
  return false;
}

/**
 * Cookie name for the current person-scope. Set by HomeFilterBar when the
 * user picks someone in the home-page dropdown; read by the server-component
 * layout so the nav's projects dropdown shows the same scoped list.
 *
 * Value is the person's full display name (URI-decoded). Empty / missing
 * cookie means "show everything" — same semantics as `?person=__all__`.
 */
export const SCOPE_PERSON_COOKIE = "hub_scope_person";

/**
 * Build the set of project names the given person is on. Returns `null`
 * when there's no scope to apply (empty person) or the scope would match
 * zero projects — the null-sentinel lets callers fall back to "show all"
 * instead of rendering a confusingly-empty page for a stale cookie.
 *
 * Callers should treat `null` as "don't filter" and a non-null Set as
 * "only keep items whose project is in this set".
 */
export function scopedProjectNames(
  projects: Project[],
  person: string,
): Set<string> | null {
  if (!person) return null;
  const s = new Set<string>();
  for (const p of projects) {
    if (isPersonOnProject(p, person)) s.add(p.name);
  }
  return s.size > 0 ? s : null;
}

/**
 * Personal-dashboard scope: narrow a `getMyProjects` response to "projects
 * where this person is actually on the roster". Used by the home grid +
 * top-nav projects dropdown so they don't dump the entire access list on
 * @fandf.co.il staff (who are granted blanket internal-project access by
 * `getMyProjectsDirect` for navigation purposes — the home/nav surfaces
 * want a personal view, not an access list).
 *
 * Clients are returned unchanged — their list is already access-gated by
 * email server-side and they're not on rosters as people. Empty `person`
 * also returns the full list. If the filter would strip every project
 * (e.g. an admin not on any project's roster), we fall back to the full
 * list so the page isn't misleadingly empty.
 */
export function scopeProjectsToPerson(
  projects: Project[],
  personName: string,
  isClient: boolean,
): Project[] {
  if (isClient || !personName) return projects;
  const filtered = projects.filter((p) => isPersonOnProject(p, personName));
  return filtered.length > 0 ? filtered : projects;
}
