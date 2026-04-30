/**
 * "View as" effective-value resolver.
 *
 * As of 2026-04-30 the gear menu's "view as" toggle writes to a SESSION
 * COOKIE (`hub_view_as`), not to the User Preferences sheet. The cookie:
 *
 *   - Survives client-side navigation within the same tab
 *   - Survives a hard refresh **only** if the beforeunload handler
 *     didn't fire — but `ViewAsCookieGuard.tsx` clears it on every
 *     beforeunload, so refresh = back to actual user
 *   - Cleared on tab close (no max-age set)
 *
 * The sheet column `view_as_email` still exists, used by the admin
 * page (`/admin/user-prefs`) for "set a default for X". When both the
 * cookie and sheet are populated, the cookie wins — the user's recent
 * peek overrides the persistent admin setting.
 *
 * Server pages consume effective view-as via `getEffectiveViewAs`.
 */

import { cookies } from "next/headers";
import { getUserPrefs } from "@/lib/userPrefs";

export const VIEW_AS_COOKIE = "hub_view_as";

/** Effective view-as email for the given user.
 *  - Returns the cookie value when present (transient, gear-menu-set)
 *  - Else returns the sheet's `view_as_email` (admin-set default)
 *  - Else returns "" (act as self) */
export async function getEffectiveViewAs(userEmail: string): Promise<string> {
  try {
    const ck = await cookies();
    const v = (ck.get(VIEW_AS_COOKIE)?.value || "").toLowerCase().trim();
    if (v) return v;
  } catch {
    // cookies() can throw outside a request scope (e.g., in build-time
    // static rendering). Fall through to the sheet fallback.
  }
  try {
    const prefs = await getUserPrefs(userEmail);
    return (prefs.view_as_email || "").toLowerCase().trim();
  } catch {
    return "";
  }
}
