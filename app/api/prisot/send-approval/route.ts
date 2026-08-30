import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getDriveFileMeta } from "@/lib/driveFolders";
import { sendNotificationEmail } from "@/lib/notifications";
import { buildPrisaApprovalEmail } from "@/lib/prisaApprovalEmail";
import {
  APPROVAL_LINK_TTL_MS,
  attachPrisaApprovalThread,
  deletePrisaApprovalRequest,
  getPrisaApprovalRequest,
  putPrisaApprovalRequest,
  signPrisaApprovalToken,
} from "@/lib/prisaApprovalTokens";
import { getPrisotChangeRequest } from "@/lib/prisotChangeRequests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "📤 שלח לאישור" — the hub's own approval-request send, replacing
 * /api/drive/approvals/create (Drive Approvals API).
 *
 * ONE email, addressed to everyone — the way a person would send it, so
 * the client side gets a single thread they can reply-all on instead of
 * N identical copies that read as machine output. It goes out from the
 * requesting user's own Gmail identity, so replies land in their inbox
 * rather than in a no-reply Google void.
 *
 * It carries one signed, expiring link (lib/prisaApprovalTokens.ts)
 * shared by all recipients. That link opens /approve/<token>, which
 * renders the plan and its אשר / בקש שינויים buttons with no login —
 * the wall that made the Drive flow go uncompleted. Because the link
 * names no person, the page asks which recipient is signing off when
 * there's more than one; see `resolveApprover`.
 *
 * Unlike the Drive flow this needs NO Drive writes: no anyone-with-link
 * grant, no per-recipient share, no Google-account probe. The public
 * page reads the sheet under the service account and renders it inline,
 * so a recipient without a Google account is a first-class case now
 * instead of a hard error.
 *
 * Session-auth only (internal users send; clients receive). Per-recipient
 * send failures are collected rather than thrown, so one bad address
 * doesn't strand the rest.
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
    fileName?: string;
    mimeType?: string;
    project?: string;
    company?: string;
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
  if (!fileId) {
    return NextResponse.json(
      { ok: false, error: "fileId required" },
      { status: 400 },
    );
  }
  const recipients = Array.from(
    new Set(
      (body.approvers || [])
        .map((e) => String(e || "").toLowerCase().trim())
        .filter((e) => e.includes("@")),
    ),
  );
  if (recipients.length === 0) {
    return NextResponse.json(
      { ok: false, error: "יש לבחור לפחות נמען אחד" },
      { status: 400 },
    );
  }

  // Name and type come from Drive, not from the client. The dialog gets
  // its fileName from a server render that can be minutes old, so a plan
  // renamed shortly before sending went out under the stale name — that
  // is exactly how "Copy of 2026-07-28 essence" reached a client whose
  // file had already been renamed to "2026-08-20 גן יבנה" a minute
  // earlier. It also means the posted string, which any signed-in user
  // controls, can no longer land verbatim in an outbound email subject.
  // Posted values stay as the fallback so a Drive blip doesn't block a send.
  const live = await getDriveFileMeta(email, fileId);
  const fileName = live?.name || String(body.fileName || "").trim() || "פריסה";
  const mimeType = live?.mimeType || String(body.mimeType || "").trim();
  const projectName = String(body.project || "").trim();
  const company = String(body.company || "").trim();
  const message = String(body.message || "").trim().slice(0, 2000);
  const expiresAt = new Date(Date.now() + APPROVAL_LINK_TTL_MS).toISOString();

  // What came before this send: the conversation the last mail landed in,
  // and any change request still open against the plan. Both are read
  // before the doc is replaced — putPrisaApprovalRequest writes without
  // merge, so the thread would be lost otherwise. Neither is worth failing
  // the send over.
  const [prev, change] = await Promise.all([
    getPrisaApprovalRequest(fileId).catch(() => null),
    getPrisotChangeRequest(fileId).catch(() => null),
  ]);

  // Record FIRST. The doc is what flips the card to "⏳ נשלח לאישור" and
  // what the public page checks before honouring a token — if we emailed
  // first and the write then failed, recipients would hold links that
  // verify but resolve to "request not found".
  try {
    await putPrisaApprovalRequest({
      fileId,
      fileName,
      mimeType,
      projectName,
      company,
      sentBy: email,
      sentAt: new Date().toISOString(),
      recipients,
      expiresAt,
      message,
      // Carried forward so the revision continues the same conversation.
      ...(prev?.emailThreadId
        ? {
            emailThreadId: prev.emailThreadId,
            emailMessageId: prev.emailMessageId,
            emailSentBy: prev.emailSentBy,
          }
        : {}),
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: `לא ניתן לשמור את בקשת האישור: ${
          e instanceof Error ? e.message : String(e)
        }`,
      },
      { status: 500 },
    );
  }

  const base = (process.env.AUTH_URL || "").replace(/\/+$/, "");
  const token = signPrisaApprovalToken({ fileId, expiresAt });
  const { subject, plainBody, htmlBody } = buildPrisaApprovalEmail({
    fileName,
    projectName,
    company,
    senderEmail: email,
    message,
    approveUrl: `${base}/approve/${token}`,
    expiresAt,
    ...(change?.note
      ? {
          changeNote: {
            text: change.note,
            requestedAt: change.requestedAt,
          },
        }
      : {}),
  });

  // Continue the original conversation when this is the same sender —
  // Gmail refuses a threadId belonging to another mailbox, so a colleague
  // re-sending starts a fresh thread rather than erroring.
  const canThread =
    !!prev?.emailThreadId &&
    (prev.emailSentBy ?? "").toLowerCase() === email.toLowerCase();
  const mail = {
    fromEmail: email,
    // Comma-joined address list — one message, every recipient on the
    // To: line and visible to each other, so a reply-all reaches the
    // whole group. Not Bcc: these people are meant to see that their
    // colleagues were asked too.
    toEmail: recipients.join(", "),
    subject,
    plainBody,
    htmlBody,
  };
  try {
    let sent;
    try {
      sent = await sendNotificationEmail(
        canThread
          ? {
              ...mail,
              threadId: prev!.emailThreadId,
              inReplyTo: prev!.emailMessageId || undefined,
            }
          : mail,
      );
    } catch (threadErr) {
      // A thread can go stale — deleted, or moved out of this mailbox. The
      // mail matters more than the threading, so fall back to a fresh one
      // rather than failing the send.
      if (!canThread) throw threadErr;
      console.warn(
        `[send-approval] threaded send failed for fileId=${fileId}, retrying unthreaded: ${
          threadErr instanceof Error ? threadErr.message : String(threadErr)
        }`,
      );
      sent = await sendNotificationEmail(mail);
    }
    // Keep the ORIGINAL thread, advance the message id so the next
    // re-send replies to what was actually sent last.
    await attachPrisaApprovalThread(fileId, {
      threadId: prev?.emailThreadId || sent.threadId,
      messageId: sent.messageId,
      sentBy: email,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.warn(
      `[send-approval] failed to email [${recipients.join(", ")}] for fileId=${fileId}: ${reason}`,
    );
    // A single send means a single failure mode: nobody got it. Roll the
    // request doc back — leaving it would flip the card to
    // "⏳ נשלח לאישור" for a message that never went out, which is both a
    // lie and a trap (pending is the state the team can't act from until
    // it expires). Deleting it restores the ⛔ badge and the send button.
    await deletePrisaApprovalRequest(fileId);
    return NextResponse.json(
      { ok: false, error: `שליחת המייל נכשלה: ${reason}` },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true, sent: recipients.length });
}
