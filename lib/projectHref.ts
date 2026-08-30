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
export const GENERAL_PROJECT_NAME = "כללי";

/**
 * How to NAME a project to someone reading it cold — an approval email,
 * the login-free approve page, anywhere the reader has no other context.
 *
 * Same collision rule as the href below, for the same reason: every
 * company has a כללי, so on its own it identifies nothing. Everywhere
 * else the project name is unique and the company beside it is noise.
 */
export function projectLabel(projectName: string, company: string): string {
  if (projectName === GENERAL_PROJECT_NAME && company) {
    return `${projectName} · ${company}`;
  }
  return projectName;
}

export function projectHref(
  projectName: string,
  company: string,
  /** Rail section to open on arrival (`?section=`), e.g. "prisot" from
   *  the emailed פריסה approval page — landing on the plans instead of
   *  the report's default section. Omitted for a plain project link. */
  section?: string,
): string {
  const path = `/projects/${encodeURIComponent(projectName)}`;
  const qs: string[] = [];
  // Only append `?company=...` when the name is ambiguous. כללי is the
  // only collision in practice today; other projects are unique by
  // name and adding the param everywhere would just clutter URLs.
  if (company && projectName === GENERAL_PROJECT_NAME) {
    qs.push(`company=${encodeURIComponent(company)}`);
  }
  if (section) qs.push(`section=${encodeURIComponent(section)}`);
  return qs.length ? `${path}?${qs.join("&")}` : path;
}
