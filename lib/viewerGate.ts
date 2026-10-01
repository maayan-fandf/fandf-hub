import { NextResponse } from "next/server";
import { currentUserEmail } from "@/lib/appsScript";
import { viewerTier, type ViewerTier } from "@/lib/viewerTier";

/**
 * Route-handler gates by viewer tier (lib/viewerTier). Use at the top of a
 * handler, before reading the body or touching any Google API:
 *
 *   const gate = await requireStaff();
 *   if (gate instanceof NextResponse) return gate;
 *   const email = gate.email;
 *
 * WHICH ONE. The service account acts as the caller only for @fandf.co.il
 * addresses; for everyone else lib/sa substitutes DRIVE_FOLDER_OWNER. So a
 * route that never checks who is calling does its work AS THE OWNER for any
 * outside account — that is how "any signed-in Google account" could read
 * the owner's inbox, list the shared drive and post to Chat in her name
 * (authorization audit, 2026-10-01).
 *
 *   requireStaff  — the route reads, writes or SPEAKS AS something personal
 *                   to the caller: Gmail (reading it, or sending from it),
 *                   Calendar, Google Tasks, a Google Chat message posted
 *                   under the caller's name, the assistant whose tools run
 *                   as the caller. For an outside account "personal" means
 *                   the owner's, so only @fandf.co.il.
 *   requireTeam   — the route works on SHARED internal resources as the
 *                   owner identity (Drive folders, work tasks, campaigns,
 *                   alerts): staff, plus the outside freelancers Keys lists
 *                   as internal. Never clients.
 *   requireViewer — any account that is in the hub at all (not a stranger).
 *                   `auth()` already refuses strangers; this is for a route
 *                   that otherwise never asks who is calling.
 *
 * None of these says anything about WHICH PROJECT. A route that takes a
 * project, folder or file id from the caller and may be reached by clients
 * still has to check it (lib/projectAccess, getAccessScope).
 *
 * The email is always the session's own — never a "view as" target.
 */
export type ViewerGate = { email: string; tier: ViewerTier };

async function gate(
  allow: (tier: ViewerTier) => boolean,
): Promise<ViewerGate | NextResponse> {
  const email = await currentUserEmail().catch(() => "");
  if (!email) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const tier = await viewerTier(email);
  if (!allow(tier)) {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }
  return { email, tier };
}

export const requireStaff = () => gate((t) => t === "staff");
export const requireTeam = () => gate((t) => t === "staff" || t === "team");
export const requireViewer = () => gate((t) => t !== "stranger");
