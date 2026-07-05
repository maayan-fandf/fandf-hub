import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { approvePrisaViaLock } from "@/lib/driveApprovals";
import { clearPrisotChangeRequest } from "@/lib/prisotChangeRequests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Client-facing "אשר פריסה" action on the LatestPrisotCard. Locks the
 * latest פריסה sheet read-only (contentRestrictions) as the "approved
 * version" — the same signal `fetchApprovalState` reads back as ✓ מאושר.
 *
 * Unlike /api/drive/approvals/create (SendForApprovalButton — kicks off a
 * Drive Approvals flow for internal users to REQUEST client sign-off),
 * this is the terminal APPROVE step a client clicks from the hub. External
 * clients can't cast an Approvals-API vote (DWD can't impersonate
 * non-@fandf.co.il identities), so the hub records the approval as a lock
 * on their behalf, attributed to their email in the lock reason.
 *
 * Session-auth only. The button renders only inside the prisot card on a
 * real-estate project page the caller can already see; the file id is an
 * un-guessable 32-char Drive id surfaced only there — same exposure model
 * as /api/drive/approvals/create.
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
  return NextResponse.json(result);
}
