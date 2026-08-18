/**
 * Server helper for marking a פריסה (media-plan sheet) approved.
 *
 * HISTORY — this module used to own BOTH halves of the approval flow:
 * `createDriveApproval` kicked off a Drive Approvals API workflow
 * (POST /drive/v3/files/{id}/approvals:start) and `approvePrisaViaLock`
 * recorded the eventual sign-off. The Drive half was removed 2026-08-18:
 * it required every reviewer to hold a Google identity and routed them
 * through Drive's own UI, and clients simply didn't complete it. The hub
 * now sends its own emailed, signed, login-free approval links — see
 * lib/prisaApprovalTokens.ts and app/api/prisot/send-approval.
 *
 * What survives is the half that always worked: the lock. Both the
 * session-authed client button (/api/drive/approvals/approve) and the
 * token-authed emailed one (/api/prisot/token-action) land here.
 */

import { driveClient, driveFolderOwner } from "@/lib/sa";

export type ApprovePrisaResult =
  | { ok: true; approvedTime: string }
  | { ok: false; error: string; status?: number };

/**
 * Client / manual approval of a פריסה sheet by locking it read-only.
 *
 * External clients can't cast a vote on a Drive Approval — the Approvals
 * API acts as the authenticated reviewer, and our SA can only impersonate
 * @fandf.co.il identities via DWD, not external clients. So the hub's
 * client-facing "אשר פריסה" action instead marks the file approved the
 * same way Sheets' native "Approved version" UI does: a
 * contentRestrictions readOnly lock. `fetchApprovalState`
 * (lib/driveFolders.ts) already treats a readOnly lock as
 * approvalState:"approved" via its `isLocked` path — so the badge flips
 * to ✓ מאושר on the next render with zero change to the read path, and
 * the approved plan is frozen against further edits.
 *
 * The approver's email + an ISO timestamp go into the lock `reason` as an
 * audit trail (visible in Drive and surfaced in the approved-badge
 * tooltip). Reversible: an internal user can unlock from Drive / Sheets
 * to revise and re-share.
 *
 * Runs as driveFolderOwner (the SA subject that owns the Shared Drive
 * content) — the client never needs edit access to the file itself.
 */
export async function approvePrisaViaLock({
  approverEmail,
  fileId,
}: {
  approverEmail: string;
  fileId: string;
}): Promise<ApprovePrisaResult> {
  const cleanFileId = String(fileId || "").trim();
  if (!cleanFileId) return { ok: false, error: "fileId required" };
  const approver = String(approverEmail || "").toLowerCase().trim();

  const drive = driveClient(driveFolderOwner());
  const stamp = new Date().toISOString();
  // Human-readable audit trail — Drive shows this on the lock, and the
  // hub surfaces it in the approved badge tooltip.
  const reason = `אושר ע"י ${approver || "לקוח"} דרך F&F Hub · ${stamp}`;
  try {
    await drive.files.update({
      fileId: cleanFileId,
      supportsAllDrives: true,
      requestBody: {
        contentRestrictions: [{ readOnly: true, reason }],
      },
      fields: "id, contentRestrictions(readOnly, reason, restrictionTime)",
    });
    return { ok: true, approvedTime: stamp };
  } catch (e) {
    const code =
      (e as { code?: number }).code ??
      (e as { response?: { status?: number } }).response?.status;
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(
      `[approvePrisaViaLock] files.update lock failed for ${cleanFileId} (${code}): ${msg}`,
    );
    return {
      ok: false,
      error: msg,
      status: typeof code === "number" ? code : undefined,
    };
  }
}
