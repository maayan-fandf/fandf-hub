import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { createDriveApproval } from "@/lib/driveApprovals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Backs the SendForApprovalButton on the project overview's פריסה
 * אחרונה card. Authenticates via the session cookie (no Apps Script
 * round-trip needed — DWD impersonates the session user directly via
 * driveClient). Internal-only by gate placement: the button only
 * renders inside the prisot card, which is itself behind the
 * `!isClientUser` check on /projects/[project]/page.tsx.
 *
 * Surfaces Drive Approvals API errors verbatim so the UI can show
 * the user a useful message — most likely "your workspace plan
 * doesn't expose the Approvals API" (403) or "the approver doesn't
 * have access to this file" (400 — though the helper pre-shares to
 * mitigate that).
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

  let body: {
    fileId?: string;
    approvers?: string[];
    message?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid JSON body" },
      { status: 400 },
    );
  }
  const fileId = String(body.fileId || "").trim();
  const approvers = Array.isArray(body.approvers)
    ? body.approvers
        .map((e) => (typeof e === "string" ? e.trim() : ""))
        .filter((e) => e.includes("@"))
    : [];
  const message = typeof body.message === "string" ? body.message : "";

  if (!fileId) {
    return NextResponse.json(
      { ok: false, error: "fileId required" },
      { status: 400 },
    );
  }
  if (approvers.length === 0) {
    return NextResponse.json(
      { ok: false, error: "at least one approver email required" },
      { status: 400 },
    );
  }

  const result = await createDriveApproval({
    subjectEmail: email,
    fileId,
    approvers,
    message,
  });
  if (!result.ok) {
    // Pass the Drive error status through so the UI can branch on
    // 403 (workspace plan) vs 400 (bad request) vs 5xx (transient).
    // `invalidEmails` (when present) flows through unchanged so the
    // dialog can highlight which approver chips are the problem.
    return NextResponse.json(result, { status: result.status || 500 });
  }
  return NextResponse.json(result);
}
