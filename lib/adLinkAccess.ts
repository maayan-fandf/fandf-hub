/**
 * Shared gate for the Facebook Ads / Google Ads deep-link buttons that
 * appear across the hub (and, mirrored manually, the legacy dashboard).
 *
 * Per Maayan 2026-05-08 the buttons hand off to the FB Ads Manager /
 * Google Ads UI — only people who actually log into those platforms
 * end up clicking them, so we scope to:
 *
 *   - role === "Media" on names_to_emails (Maayan + Nadav today)
 *   - email === felix@fandf.co.il (he's the agency lead on media
 *     operations even though his Role row reads "Manager")
 *
 * Designers / copywriters / video editors / client managers see no
 * ad-platform pills anywhere in the hub.
 */
import type { TasksPerson } from "@/lib/appsScript";

export const FELIX_AD_LINK_BYPASS_EMAIL = "felix@fandf.co.il";

/**
 * Returns true when the given email belongs to a Media-role staffer
 * OR to Felix specifically. Falls through (false) for empty input or
 * unrecognized emails — i.e. the gate fails closed when we can't
 * resolve the user's role.
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
  return role.toLowerCase() === "media";
}
