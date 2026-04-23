import type { Project } from "@/lib/appsScript";

/**
 * Shared person-scope logic. Used by:
 *   - app/page.tsx      — filters the home-page project grid
 *   - app/layout.tsx    — filters the top-nav פרויקטים dropdown (via cookie)
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
