import { cache } from "react";
import { getAccessScope } from "@/lib/tasksDirect";

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
 * `/api/crm/signed`): @fandf.co.il staff pass on the domain; everyone else
 * needs the project in their Keys access scope, or to be a hub admin.
 *
 * FAILS CLOSED. If the scope cannot be read the answer is no — a real client
 * then sees the "no access" page for that load and a reload fixes it, which
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
    if (lc.endsWith("@fandf.co.il")) return true;
    try {
      const scope = await getAccessScope(lc);
      return scope.isAdmin || scope.accessibleProjects.has(project);
    } catch {
      return false;
    }
  },
);
