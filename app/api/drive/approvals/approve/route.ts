import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { approvePrisaViaLock } from "@/lib/driveApprovals";
import { clearPrisotChangeRequest } from "@/lib/prisotChangeRequests";
import { resolvePrisaApprovalRequest } from "@/lib/prisaApprovalTokens";

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
 * The button renders only inside the prisot card on a project page the
 * caller can already see; the file id is an un-guessable 32-char Drive
 * id surfaced only there.
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
