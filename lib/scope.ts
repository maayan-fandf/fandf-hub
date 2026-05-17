import type { Project } from "@/lib/appsScript";

/** Company-level catch-all project name. Hardcoded here (matching the
 *  pattern in lib/projectHref.ts) to keep this module client-safe and
 *  free of Apps Script imports — the canonical source is
 *  lib/appsScript.GENERAL_PROJECT_NAME. */
const GENERAL_PROJECT_NAME = "כללי";

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

/** A roster cell can list more than one person ("Name1, Name2" — e.g.
 *  שיכון ובינוי has two campaign managers in Keys' מנהל קמפיינים column).
 *  Split on the same delimiters splitRosterCell uses in projectsDirect.ts
 *  (kept inline so this module stays client-safe / server-import-free) and
 *  test each name. `mediaManager` / `projectManagerFull` arrive as raw
 *  strings (the display layer wants the original cell), so unlike
 *  `internalOnly` / `clientFacing` they aren't pre-split — do it here. */
function rosterCellHas(cell: string | undefined, target: string): boolean {
  if (!cell) return false;
  return cell
    .split(/[,;\n]/)
    .some((n) => n.trim().toLowerCase() === target);
}

export function isPersonOnProject(p: Project, person: string): boolean {
  if (!person) return false;
  const target = person.toLowerCase();
  const r = p.roster;
  if (rosterCellHas(r.mediaManager, target)) return true;
  if (rosterCellHas(r.projectManagerFull, target)) return true;
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
  if (filtered.length === 0) return projects;

  // Re-attach each represented company's "כללי" catch-all project,
  // even when the user isn't explicitly on its roster. כללי rows are
  // manually maintained (per `feedback_general_project_manual.md`)
  // and typically don't list every staff member — without this, an
  // internal user who's on, say, two of "גיא ודורון"'s projects
  // would see those two but not the company's כללי, which is
  // confusing because the personal-scope rule "you're on this
  // company's work" should imply access to its catch-all too.
  // Reported by Itay 2026-05-06: every company missing its כללי.
  const representedCompanies = new Set(filtered.map((p) => p.company));
  const filteredKeys = new Set(
    filtered.map((p) => `${p.company}|${p.name}`),
  );
  for (const p of projects) {
    if (p.name !== GENERAL_PROJECT_NAME) continue;
    if (!representedCompanies.has(p.company)) continue;
    const key = `${p.company}|${p.name}`;
    if (filteredKeys.has(key)) continue;
    filtered.push(p);
    filteredKeys.add(key);
  }
  return filtered;
}
