import { cache } from "react";
import { redirect } from "next/navigation";
import { sessionOfAnyAccount } from "@/auth";
import { getAccessScope } from "@/lib/tasksDirect";
import { isInternalViewer } from "@/lib/viewerTier";

/**
 * For a page that got NO viewer email: if that is because the signed-in
 * Google account is on no roster (auth() gives such an account no identity),
 * send it to /unauthorized — which names the address and offers sign-out.
 * Otherwise return and let the page's own "no access" path run. Without this
 * someone signed into the wrong Google account who follows a project link
 * reads "מחובר/ת כ-(לא ידוע)" and has no way out.
 */
export async function redirectIfOffRoster(viewerEmail: string): Promise<void> {
  if (viewerEmail) return;
  const anyAccount = await sessionOfAnyAccount().catch(() => null);
  if (anyAccount?.user?.email) redirect("/unauthorized");
}

/**
 * May this viewer open this project?
 *
 * THE GATE THE PROJECT PAGES DID NOT HAVE. Sign-in admits any Google account
 * (auth.ts), middleware only checks that someone is logged in, and the
 * project report is read as the service account's owner identity
 * (driveFolderOwner) — lib/sa says of that arrangement "caller is responsible
 * for separately gating the data they read against the original email". The
 * comments and tasks readers do; the page itself never did. So a client of
 * one project could type another project's URL and get its client-view
 * report, and a Google account in no Keys row at all got the FULL report —
 * `isClientUser` is false for it, so nothing was stripped (found in review,
 * 2026-10-01; in the code since the client cutover of 2026-07-27).
 *
 * Same rule as the API routes that already gate (`/api/report/fb-new-ads`,
 * `/api/crm/signed`): internal viewers pass on who they are — @fandf.co.il
 * staff, and the team members Keys lists under an outside address
 * (lib/viewerTier; owner's rule, 2026-10-01: they see everything). Everyone
 * else needs the project in their Keys access scope, or to be a hub admin.
 *
 * FAILS CLOSED. If the scope cannot be read the answer is no — a real client
 * then sees a "no access" page for that load (this one, or /unauthorized when
 * the roster itself could not be read) and trying again fixes it, which
 * is the price of not serving a report to someone we could not check
 * (owner's decision, 2026-10-01). Keys has a last-good snapshot behind it
 * (lib/keys), so in practice this needs a cold instance AND a Sheets failure.
 *
 * `email` must be the viewer's own session address — never the gear menu's
 * "view as" target, which would let an admin's impersonation lock the admin
 * out, or worse, be the thing that grants access.
 */
export const canOpenProject = cache(
  async (email: string, projectName: string): Promise<boolean> => {
    const lc = String(email || "").toLowerCase().trim();
    const project = String(projectName || "").trim();
    if (!lc || !project) return false;
    // Fails closed too: an unreadable roster makes an outside address "not
    // internal", and it falls through to the scope check below.
    if (await isInternalViewer(lc)) return true;
    try {
      const scope = await getAccessScope(lc);
      return scope.isAdmin || scope.accessibleProjects.has(project);
    } catch {
      return false;
    }
  },
);
