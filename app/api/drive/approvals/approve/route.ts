import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { approvePrisaViaLock } from "@/lib/driveApprovals";
import { getTasksSharedDriveId } from "@/lib/driveFolders";
import { clearPrisotChangeRequest } from "@/lib/prisotChangeRequests";
import { resolvePrisaApprovalRequest } from "@/lib/prisaApprovalTokens";
import { driveClient, driveFolderOwner } from "@/lib/sa";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Client-facing "אשר פריסה" action on the LatestPrisotCard. Locks the
 * latest פריסה sheet read-only (contentRestrictions) as the "approved
 * version" — the same signal `fetchApprovalState` reads back as ✓ מאושר.
 *
 * This is the SESSION-authed terminal APPROVE step, for a client who is
 * signed into the hub and looking at the project page. Its twin is
 * /api/prisot/token-action, which does the same thing for someone
 * arriving on an emailed signed link with no session at all. Both call
 * approvePrisaViaLock, so the two entry points are indistinguishable
 * downstream — the only difference is where the approver's identity
 * comes from (session here, token there).
 *
 * The request to approve is created by /api/prisot/send-approval.
 *
 * WHO MAY CALL. Clients are the intended callers, so this cannot be a
 * staff/team gate; `auth()` keeps out accounts on no roster. The file id
 * comes from the caller and the lock is set as the Shared Drive owner, so
 * the route refuses any file outside the tasks Shared Drive — every plan
 * the button is rendered for lives there. STILL OPEN (authorization
 * audit, 2026-10-01): the id is not bound to a project the caller may
 * open, so a client holding another project's plan id could approve it.
 * Closing that needs the project in the request (ApprovePrisaButton sends
 * only the file id today).
 */
export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json(
      { ok: false, error: "unauthenticated" },
      { status: 401 },
    );
  }

  let body: { fileId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid JSON body" },
      { status: 400 },
    );
  }
  const fileId = String(body.fileId || "").trim();
  if (!fileId) {
    return NextResponse.json(
      { ok: false, error: "fileId required" },
      { status: 400 },
    );
  }

  // Unchecked, this is "make any file the owner can edit read-only",
  // wherever it lives. Fails closed: a file we could not look up is not
  // locked.
  const inTasksDrive = await driveClient(driveFolderOwner())
    .files.get({ fileId, fields: "driveId", supportsAllDrives: true })
    .then((r) => r.data.driveId === getTasksSharedDriveId())
    .catch(() => null);
  // A lookup that FAILED is not a refusal: a client pressing "אשר פריסה" on
  // their own plan during a Drive hiccup should be told to try again, not
  // "Forbidden". Still nothing is locked.
  if (inTasksDrive === null) {
    return NextResponse.json(
      { ok: false, error: "לא הצלחנו לבדוק את הקובץ כרגע — נסו שוב בעוד רגע" },
      { status: 502 },
    );
  }
  if (!inTasksDrive) {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  const result = await approvePrisaViaLock({ approverEmail: email, fileId });
  if (!result.ok) {
    return NextResponse.json(result, { status: result.status || 500 });
  }
  // Approving supersedes any pending change-request — clear the chip so an
  // approved plan doesn't keep showing "🔄 התבקשו שינויים". Best-effort.
  await clearPrisotChangeRequest(fileId);
  // Close out the emailed approval request too, if there is one. Without
  // this, a client who ignored the email and approved from inside the hub
  // would leave the request unresolved — harmless for the badge (the lock
  // already reads as ✓ מאושר, which wins) but it would keep the emailed
  // links live and misreport who resolved it.
  await resolvePrisaApprovalRequest({
    fileId,
    resolution: "approved",
    resolvedBy: email,
  });
  return NextResponse.json(result);
}
