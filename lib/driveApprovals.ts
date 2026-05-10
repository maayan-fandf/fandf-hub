/**
 * Server helper for the Drive Approvals API. Used by the
 * SendForApprovalButton on the project overview's פריסה אחרונה card,
 * which lets internal users kick off an approval request against the
 * latest media-plan sheet without leaving the hub.
 *
 * The Drive Approvals API isn't formally exposed via the googleapis
 * SDK as a typed sub-resource yet, so we hit the REST endpoint
 * directly with the SA's Bearer token — same pattern as
 * `fetchApprovalState` in lib/driveFolders.ts.
 *
 * Endpoint per the official guides
 * (https://developers.google.com/workspace/drive/api/guides/approvals):
 *
 *   POST /drive/v3/files/{fileId}/approvals:start
 *
 * Request body shape (per the guides page — earlier code used an
 * approvers/requestMessage/expirationTime shape that was wrong and
 * just 400'd silently):
 *
 *   {
 *     reviewerEmails: ["alice@example.com", "bob@example.com"],
 *     dueTime: "<RFC 3339 timestamp>",
 *     lockFile: true,                 // recommended for media plans —
 *                                     // freezes the file once sent so
 *                                     // reviewers see exactly what's
 *                                     // up for approval
 *     message: "..."
 *   }
 *
 * Failure modes:
 *   - 403 — workspace plan doesn't include Approvals, or the
 *           impersonated user lacks edit access
 *   - 404 — file not found via this credential
 *   - 400 — malformed request (typically: reviewers without Drive
 *           access to the file, or the file type doesn't support
 *           approvals)
 *   - any other — surfaced verbatim to the UI for diagnosis
 *
 * The caller is responsible for ensuring reviewers have at least
 * read access to the file BEFORE calling this. Today the project
 * overview's "תיקיה משותפת" auto-share flow grants client emails
 * read on the project's shared folder (via ensureProjectSharedFolder),
 * but the פריסה sheet itself lives in the internal Shared Drive
 * tree — so we explicitly grant readers here as a side effect to
 * keep the approval flow turnkey.
 */

import { driveClient, driveFolderOwner } from "@/lib/sa";

export type CreateApprovalResult =
  | { ok: true; approvalId: string }
  | { ok: false; error: string; status?: number };

/** Default approval window — 14 days. Long enough to cover a
 *  weekend + a holiday, short enough that stale requests time out
 *  on their own without manual cleanup. */
const APPROVAL_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export async function createDriveApproval({
  subjectEmail,
  fileId,
  approvers,
  message,
}: {
  subjectEmail: string;
  fileId: string;
  approvers: string[];
  message?: string;
}): Promise<CreateApprovalResult> {
  const cleanFileId = String(fileId || "").trim();
  if (!cleanFileId) return { ok: false, error: "fileId required" };
  const approverList = approvers
    .map((e) => String(e || "").toLowerCase().trim())
    .filter((e) => e.includes("@"));
  if (approverList.length === 0) {
    return { ok: false, error: "at least one approver email required" };
  }

  // Use the deployer identity (driveFolderOwner) as the impersonated
  // subject when reachable — same convention as `findLatestPrisotInner`,
  // and matches the user that owns the Shared Drive content. The
  // session user (subjectEmail) is the requester; the SA does the
  // impersonation. For non-fandf domain users sa.ts swaps to
  // driveFolderOwner anyway (see feedback_dwd_external_users.md).
  const drive = driveClient(driveFolderOwner() || subjectEmail);

  // Pull a Bearer token off the existing client so we can hit the
  // raw REST endpoint. The googleapis SDK doesn't expose the
  // Approvals sub-resource as a typed method.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const auth2 = (drive.context as any)._options?.auth as
    | { getAccessToken: () => Promise<{ token?: string | null }> }
    | undefined;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const tokenResp = await auth2?.getAccessToken?.();
  const token = tokenResp?.token;
  if (!token) return { ok: false, error: "auth token unavailable" };

  // Pre-grant readers — Drive Approvals needs the approver to have
  // access to the file. Without this, the create call typically
  // returns 400 with "approver does not have access". Best-effort:
  // 409 ALREADY_EXISTS is fine (already a member); other failures
  // are logged but don't block the create — Drive may still send
  // the email with a "request access" link.
  for (const email of approverList) {
    try {
      await drive.permissions.create({
        fileId: cleanFileId,
        sendNotificationEmail: false,
        supportsAllDrives: true,
        requestBody: { type: "user", role: "reader", emailAddress: email },
      });
    } catch (e) {
      const code =
        (e as { code?: number }).code ??
        (e as { response?: { status?: number } }).response?.status;
      if (code === 409 || code === 400) {
        // Already a member, OR the user couldn't be granted (e.g. they
        // already have higher role). Either way the create call below
        // is what matters; press on.
        continue;
      }
      console.warn(
        `[createDriveApproval] permissions.create failed for ${email} on ${cleanFileId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  const dueTime = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
  // Path uses the `:start` action suffix per the documented guide.
  // Do NOT add ?supportsAllDrives=true — the /approvals sub-resource
  // rejects it with 400 (param is only valid on /files, /files.list,
  // etc.). Verified 2026-05-10 via the
  // /api/admin/debug/drive-approvals diagnostic.
  const url =
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
      cleanFileId,
    )}/approvals:start`;
  const body = {
    reviewerEmails: approverList,
    message: (message || "").trim() || "פריסה לאישור",
    dueTime,
    // lockFile=true freezes the file while approval is in flight so
    // reviewers vote on exactly what was sent. Matches what Drive's
    // own UI does by default. Users can still cancel the approval
    // from Drive to unlock if they need to revise.
    lockFile: true,
  };

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (!r.ok) {
      const errBody = await r.text().catch(() => "");
      console.warn(
        `[createDriveApproval] ${r.status} for fileId=${cleanFileId}: ${errBody.slice(
          0,
          400,
        )}`,
      );
      return {
        ok: false,
        error:
          `Drive Approvals API returned ${r.status}: ${
            errBody.slice(0, 240) || r.statusText || "unknown"
          }`,
        status: r.status,
      };
    }
    const data = (await r.json().catch(() => ({}))) as {
      approvalId?: string;
      id?: string;
    };
    return { ok: true, approvalId: data.approvalId || data.id || "" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(
      `[createDriveApproval] network/parse failure for ${cleanFileId}: ${msg}`,
    );
    return { ok: false, error: msg };
  }
}
