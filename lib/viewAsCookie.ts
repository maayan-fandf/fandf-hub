/**
 * "View as" effective-value resolver.
 *
 * As of 2026-04-30 the gear menu's "view as" toggle writes to a SESSION
 * COOKIE (`hub_view_as`), not to the User Preferences sheet. The cookie:
 *
 *   - Survives client-side navigation within the same tab
 *   - Survives a hard refresh **only** if the beforeunload handler
 *     didn't fire — but `ViewAsBanner.tsx` clears it on every
 *     beforeunload, so refresh = back to actual user
 *   - Cleared on tab close (no max-age set)
 *
 * The sheet column `view_as_email` is now legacy. It used to be the
 * primary store (gear-menu writes pre-2026-04-30) and was kept as a
 * "persistent admin-set default" fallback after the cookie cutover.
 * That fallback caused the 2026-05-03 nadav@/maayan@ regression: a
 * stale value sat on nadav's row from the old model, and the cookie
 * exit button only cleared the cookie — so every subsequent render
 * fell through to the sheet and re-pinned him to maayan. The fallback
 * has been removed: only the cookie applies at render time. The
 * sheet column is still read by `/admin/user-prefs` for visibility +
 * cleanup, and `setUserPrefs(view_as_email: "")` from the exit button
 * scrubs any legacy value the next time someone exits view-as.
 *
 * Server pages consume effective view-as via `getEffectiveViewAs`.
 */

import { cookies } from "next/headers";
import { HUB_ADMIN_EMAILS } from "@/lib/tasksDirect";

export const VIEW_AS_COOKIE = "hub_view_as";

/** Effective view-as email for the given user.
 *
 *  Returns the `hub_view_as` cookie value when present AND the caller
 *  is an admin. Non-admins always render as themselves regardless of
 *  any client-side persistence — the feature is admin-only and the
 *  server is the only place that decision is enforced.
 *
 *  Returns "" (act as self) when:
 *    - cookie is unset
 *    - caller is not in HUB_ADMIN_EMAILS
 *    - cookie matches the caller's own email (no-op scope) */
export async function getEffectiveViewAs(userEmail: string): Promise<string> {
  const lc = (userEmail || "").toLowerCase().trim();
  if (!lc) return "";

  let cookieValue = "";
  try {
    const ck = await cookies();
    cookieValue = (ck.get(VIEW_AS_COOKIE)?.value || "").toLowerCase().trim();
  } catch {
    // cookies() can throw outside a request scope (e.g., in build-time
    // static rendering). Treat as no cookie.
    return "";
  }

  if (!cookieValue) return "";
  if (cookieValue === lc) return "";

  if (!HUB_ADMIN_EMAILS.has(lc)) {
    // Defense-in-depth: the gear-menu UI is shown to everyone, but
    // only admins are allowed to act-as. If a non-admin has a
    // hub_view_as cookie set (legacy data, shared browser, manual
    // tampering), drop it server-side and surface a log so the
    // regression is visible in App Hosting logs.
    console.warn(
      "[viewAs] suppressing scope for non-admin",
      JSON.stringify({ caller: lc, attempted: cookieValue }),
    );
    return "";
  }

  return cookieValue;
}
