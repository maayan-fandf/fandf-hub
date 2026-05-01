/**
 * Build the canonical /projects/<name> URL with optional `?company=X`
 * disambiguation. The company query param is appended ONLY when the
 * name is known to collide across companies — today that's `כללי`
 * (one per company by design). For all other names we keep the URL
 * lean since the legacy first-match-by-name behavior on the project
 * page is correct when the name is globally unique.
 *
 * Centralizing the rule here keeps every link site consistent: home
 * page, nav menu, customer-emails picker, command palette, etc. all
 * produce the same URL shape for the same (name, company) pair.
 *
 * The project page (app/projects/[project]/page.tsx) reads `?company`
 * and scopes its projectMeta + chatSpaceUrl + Drive folder + tasks
 * lookup by it. Without `?company`, the page falls through to the
 * legacy first-match-by-name path — backwards-compatible with old
 * bookmarks + emailed deep-links.
 *
 * The catchall name is hard-coded here (instead of imported from
 * lib/appsScript.GENERAL_PROJECT_NAME) so this module stays free of
 * server-only dependencies. lib/appsScript pulls in the keys cache
 * which uses revalidateTag — fine in server components but breaks
 * when this helper is imported by a client component (TasksQueue
 * hit this on the 2026-05-01 build).
 */
const GENERAL_PROJECT_NAME = "כללי";

export function projectHref(projectName: string, company: string): string {
  const path = `/projects/${encodeURIComponent(projectName)}`;
  if (!company) return path;
  // Only append `?company=...` when the name is ambiguous. כללי is the
  // only collision in practice today; other projects are unique by
  // name and adding the param everywhere would just clutter URLs.
  if (projectName !== GENERAL_PROJECT_NAME) return path;
  return `${path}?company=${encodeURIComponent(company)}`;
}
