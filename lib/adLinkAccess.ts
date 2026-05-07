/**
 * Shared gate for the Facebook Ads / Google Ads deep-link buttons that
 * appear across the hub (and, mirrored manually, the legacy dashboard).
 *
 * Per Maayan 2026-05-08 the buttons hand off to the FB Ads Manager /
 * Google Ads UI — only people who actually log into those platforms
 * end up clicking them, so we scope to:
 *
 *   - role === "Media" on names_to_emails (Maayan + Nadav today)
 *   - role === "Client Manager" — the account managers loop into
 *     ad-platform sessions to read campaign performance with clients
 *   - email === felix@fandf.co.il (agency lead on media operations
 *     even though his Role row reads "Manager")
 *
 * Designers / copywriters / video editors / generic "Manager" rows
 * still see no ad-platform pills anywhere in the hub.
 */
import type { TasksPerson } from "@/lib/appsScript";

export const FELIX_AD_LINK_BYPASS_EMAIL = "felix@fandf.co.il";
const AD_LINK_ROLES = new Set(["media", "client manager"]);

/**
 * Returns true when the given email's role on names_to_emails matches
 * one of the ad-platform-eligible roles, OR when the email is Felix's.
 * Falls through (false) for empty input or unrecognized emails — i.e.
 * the gate fails closed when we can't resolve the user's role.
 */
export function canViewAdLinks(
  email: string,
  people: TasksPerson[] | undefined | null,
): boolean {
  const lc = (email || "").toLowerCase().trim();
  if (!lc) return false;
  if (lc === FELIX_AD_LINK_BYPASS_EMAIL) return true;
  const role = (people ?? []).find(
    (p) => p.email.toLowerCase().trim() === lc,
  )?.role ?? "";
  return AD_LINK_ROLES.has(role.toLowerCase().trim());
}
