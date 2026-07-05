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
  | {
      ok: true;
      approvalId: string;
      /** Per-email outcome of the pre-share step. Drive Approvals
       *  doesn't grant access on :start, so we share each reviewer
       *  as reader BEFORE kicking off the approval. Failures here
       *  don't block the approval (Drive still emails) but mean the
       *  recipient may hit "Request access" when they click the
       *  link. Surfaced to the UI so the user can manually share or
       *  pick different reviewers. */
      shareFailures: { email: string; reason: string }[];
    }
  | {
      ok: false;
      error: string;
      status?: number;
      /** Approvers whose emails aren't associated with a Google account.
       *  Drive Approvals API rejects the whole call if ANY reviewer lacks
       *  a Google identity (regular file sharing's PIN-flow workaround
       *  doesn't apply to the approval workflow). When this is non-empty,
       *  the UI renders a tailored, actionable Hebrew message instead of
       *  the cryptic "One or more reviewer email addresses are invalid"
       *  the API returns. */
      invalidEmails?: string[];
    };

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

  // Pre-grant readers — Drive Approvals does NOT grant access at
  // :start time, so recipients without a permission on the file
  // land on "Request access" when they click the email link.
  //
  // We use a SINGLE "anyone with the link" permission instead of
  // per-recipient user shares for one specific reason: the Drive
  // visitor-verification PIN flow. When you grant `type: user` with
  // an external (non-Workspace) email, Drive treats the recipient
  // as a "visitor" and forces them to verify identity via a 6-digit
  // code emailed separately before they can open the file. For
  // media-plan approvals where the recipient is a client that just
  // wants to glance at the file and reply, that's needless friction
  // — reported by maayan on /projects/לוריא after the Marketing1
  // recipient got a verification code.
  //
  // anyone-with-link reader access:
  //   - No PIN. No verification email. One click on the approval
  //     email opens the file directly.
  //   - Google-account holders still see Approve/Decline buttons
  //     in Drive UI as expected.
  //   - Non-Google-account recipients view the file and reply by
  //     email; an internal user marks the file approved manually
  //     when ready.
  //
  // Trade-off: anyone with the URL can view the file. The 32-char
  // file ID is un-guessable in practice and we only ever surface
  // the URL through the recipient's email — same exposure surface
  // as a per-recipient share. We accept this for media-plan
  // approvals; sensitive work should keep using Drive's UI directly.
  //
  // Falls back to per-recipient user shares if the org has
  // anyone-with-link disabled (the create call returns 403 with a
  // policy-violation error). Per-email failures are tracked and
  // surfaced to the UI so the user knows what to do.
  const shareFailures: { email: string; reason: string }[] = [];
  let usedFallback = false;
  try {
    await drive.permissions.create({
      fileId: cleanFileId,
      sendNotificationEmail: false,
      supportsAllDrives: true,
      requestBody: { type: "anyone", role: "reader" },
    });
  } catch (e) {
    const code =
      (e as { code?: number }).code ??
      (e as { response?: { status?: number } }).response?.status;
    const reason = e instanceof Error ? e.message : String(e);
    console.warn(
      `[createDriveApproval] anyone-with-link share failed (${code}): ${reason} — falling back to per-recipient user shares with PIN flow`,
    );
    usedFallback = true;
  }
  // Fallback path: org policy forbids anyone-with-link sharing, so
  // we issue per-recipient user shares. This is the older, PIN-
  // gated flow — recipients on non-Workspace domains will hit a
  // verification code email. Accept the friction since the alternative
  // is "Request access" for everyone.
  if (usedFallback) {
    for (const email of approverList) {
      try {
        await drive.permissions.create({
          fileId: cleanFileId,
          sendNotificationEmail: true,
          emailMessage:
            (message || "").trim() ||
            "פריסה לאישור — קישור יישלח גם דרך זרימת האישור של Drive.",
          supportsAllDrives: true,
          requestBody: {
            type: "user",
            role: "reader",
            emailAddress: email,
          },
        });
      } catch (e) {
        const code =
          (e as { code?: number }).code ??
          (e as { response?: { status?: number } }).response?.status;
        if (code === 409) continue;
        const reason = e instanceof Error ? e.message : String(e);
        console.warn(
          `[createDriveApproval] permissions.create failed for ${email} on ${cleanFileId} (${code}): ${reason}`,
        );
        shareFailures.push({ email, reason });
      }
    }
  }

  // Pre-validate each approver against the Google-account requirement.
  // Drive Approvals API rejects the whole `:start` call if ANY reviewer
  // lacks a Google identity (regular file sharing has a visitor/PIN
  // workaround, but Approvals doesn't — verified 2026-05-12 with
  // tanya_b@shikunbinui.com which has no Google account: regular
  // permissions.create with sendNotificationEmail:false returned a
  // detailed "no Google account associated" error, while approvals:start
  // just returned the opaque "reviewerEmailAddresses invalid").
  //
  // Probe via permissions.create({ sendNotificationEmail: false,
  // type: 'user' }). For Google-accounted emails it succeeds (incidentally
  // adding a per-user reader permission — harmless duplicate of the
  // anyone-with-link grant above). For non-Google emails it returns 400
  // with a message containing "no Google account". 409 = already a
  // member = treat as success. Other errors don't block the approval
  // (they go into shareFailures alongside the existing flow's).
  const invalidEmails: string[] = [];
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
      const reason = e instanceof Error ? e.message : String(e);
      if (code === 409 || /already.*exist/i.test(reason)) continue;
      if (
        code === 400 &&
        /no Google account/i.test(reason)
      ) {
        invalidEmails.push(email);
        continue;
      }
      // Anything else: log and capture, but don't block. Most likely a
      // workspace-policy rejection that the user can debug from the
      // share-failures display.
      console.warn(
        `[createDriveApproval] probe permissions.create failed for ${email} on ${cleanFileId} (${code}): ${reason}`,
      );
      shareFailures.push({ email, reason });
    }
  }
  if (invalidEmails.length > 0) {
    const list = invalidEmails.join(", ");
    // Hebrew, actionable, explains the WHY plus the fix. The UI ALSO
    // gets the invalidEmails array on the response so it can highlight
    // individual chips, but this message stands alone for users who
    // just read the error text.
    const msg =
      invalidEmails.length === 1
        ? `הכתובת ${list} אינה משויכת לחשבון Google, ולכן Drive Approvals לא מקבל אותה כמאשר. ` +
          `הפתרון הקל ביותר: בקש מהנמען ליצור חשבון Google חינמי דרך accounts.google.com/SignUp — ` +
          `בלחיצה על "Use my current email address instead". האימייל עצמו לא משתנה — רק נוצרת זהות Google ` +
          `שמאפשרת לו ללחוץ "אשר/דחה" בקובץ. לאחר מכן שלח שוב לאישור.`
        : `הכתובות הבאות אינן משויכות לחשבון Google: ${list}. Drive Approvals דורש זהות Google מכל מאשר. ` +
          `הפתרון: כל אחד מהנמענים צריך ליצור חשבון Google חינמי דרך accounts.google.com/SignUp ` +
          `עם הכתובת הקיימת שלו (אופציית "Use my current email address instead") — האימייל לא משתנה.`;
    return {
      ok: false,
      error: msg,
      status: 400,
      invalidEmails,
    };
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
    return {
      ok: true,
      approvalId: data.approvalId || data.id || "",
      shareFailures,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(
      `[createDriveApproval] network/parse failure for ${cleanFileId}: ${msg}`,
    );
    return { ok: false, error: msg };
  }
}

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
