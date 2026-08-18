import { NextResponse } from "next/server";
import { approvePrisaViaLock } from "@/lib/driveApprovals";
import {
  clearPrisotChangeRequest,
  upsertPrisotChangeRequest,
} from "@/lib/prisotChangeRequests";
import {
  getPrisaApprovalRequest,
  isAwaitingApproval,
  resolveApprover,
  resolvePrisaApprovalRequest,
  tokenMatchesRequest,
  verifyPrisaApprovalToken,
} from "@/lib/prisaApprovalTokens";
import { createMentionDirect } from "@/lib/commentsWriteDirect";
import { sendNotificationEmail } from "@/lib/notifications";
import { driveFolderOwner } from "@/lib/sa";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Token-authed terminal actions for the login-free approval flow —
 * the endpoint behind the buttons on /approve/<token>.
 *
 * PUBLIC (exempted in middleware.ts). Auth is the HMAC token itself,
 * which names the fileId it unlocks; the request doc must also still be
 * unresolved and unexpired.
 *
 * The token is shared by everyone on the approval email, so it names no
 * person. Who to attribute the decision to comes from the request body
 * — and is therefore never trusted as sent: `resolveApprover` accepts it
 * only if it's one of the addresses the team actually mailed, and skips
 * the question entirely when there was just one recipient.
 *
 * Mirrors the session-authed pair (/api/drive/approvals/approve and
 * /api/projects/request-changes) so both entry points land in exactly
 * the same state — a readOnly content lock for approve, a change-request
 * doc plus a client-visible discussion post for changes.
 */
export async function POST(req: Request) {
  let body: { token?: string; action?: string; note?: string; as?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid JSON body" },
      { status: 400 },
    );
  }

  const action = String(body.action || "").trim();
  if (action !== "approve" && action !== "changes") {
    return NextResponse.json(
      { ok: false, error: "action must be approve|changes" },
      { status: 400 },
    );
  }

  const verified = verifyPrisaApprovalToken(String(body.token || ""));
  if (!verified.ok) {
    const msg =
      verified.reason === "expired"
        ? "פג תוקף הקישור. בקשו מהצוות לשלוח קישור חדש."
        : "הקישור אינו תקין.";
    return NextResponse.json(
      { ok: false, error: msg, reason: verified.reason },
      { status: 401 },
    );
  }
  const { fileId } = verified;

  const request = await getPrisaApprovalRequest(fileId);
  if (!request) {
    return NextResponse.json(
      { ok: false, error: "בקשת האישור לא נמצאה.", reason: "missing" },
      { status: 404 },
    );
  }
  // This token must belong to the CURRENT send. A re-send after a
  // revision overwrites the doc in place, and the recipient list it
  // carries is the only thing attribution is derived from — so an old
  // link resolving against a new list can record an approval under a
  // name that never clicked. See tokenMatchesRequest.
  if (!tokenMatchesRequest(verified.expiresAt, request)) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "הקישור הזה שייך לגרסה קודמת של הפריסה. חפשו את המייל האחרון, או בקשו מהצוות לשלוח קישור מעודכן.",
        reason: "superseded",
      },
      { status: 409 },
    );
  }

  // Already decided. The two actions are NOT symmetric here:
  //
  //   approve  — idempotent. The file is locked either way, so a client
  //              clicking twice should see success, not an error.
  //
  //   changes  — must still go through. A client who spots a problem
  //              right after someone else approved (or after the team
  //              approved from inside the hub) is reporting something
  //              real, and the earlier version of this branch returned
  //              ok:true without writing the chip, posting the
  //              discussion message, or emailing the sender. They saw
  //              "ההערה הועברה לצוות" and the note went nowhere. Only a
  //              request that is expired or superseded is genuinely too
  //              stale to accept.
  if (!isAwaitingApproval(request)) {
    if (action === "approve" && request.resolution === "approved") {
      return NextResponse.json({ ok: true, alreadyResolved: true });
    }
    const expired = !request.resolution;
    if (action === "approve" || expired) {
      return NextResponse.json(
        {
          ok: false,
          error: expired
            ? "פג תוקף בקשת האישור. בקשו מהצוות לשלוח קישור חדש."
            : "הבקשה כבר טופלה. בקשו מהצוות לשלוח קישור חדש.",
          reason: "resolved",
        },
        { status: 409 },
      );
    }
    // falls through: a change-request on an already-resolved (but not
    // expired) plan is accepted and recorded below.
  }

  // Who this decision belongs to. Validated against the stored recipient
  // list, so the browser can't invent an approver.
  const who = resolveApprover(request, String(body.as || ""));
  if (!who.ok) {
    return NextResponse.json({ ok: false, error: who.error }, { status: 400 });
  }
  const email = who.email;

  if (action === "approve") {
    const result = await approvePrisaViaLock({ approverEmail: email, fileId });
    if (!result.ok) {
      // Never hand a client Drive's raw error string — they'd see
      // "Internal Error" or "File not found" in the middle of a Hebrew
      // page and have no idea what to do. approvePrisaViaLock already
      // logged the real message with the fileId for us to diagnose.
      console.warn(
        `[token-action] approve failed for ${email} on ${fileId}: ${result.error}`,
      );
      return NextResponse.json(
        {
          ok: false,
          error:
            "לא הצלחנו לרשום את האישור כרגע. נסו שוב בעוד רגע, או פנו לצוות ונאשר ידנית.",
        },
        { status: result.status || 500 },
      );
    }
    // Approving supersedes any pending change-request chip, same as the
    // session-authed route does.
    await clearPrisotChangeRequest(fileId);
    await resolvePrisaApprovalRequest({
      fileId,
      resolution: "approved",
      resolvedBy: email,
    });
    return NextResponse.json({ ok: true, approvedTime: result.approvedTime });
  }

  // ── action === "changes" ──────────────────────────────────────────
  const note = String(body.note || "").trim().slice(0, 2000);
  if (!note) {
    return NextResponse.json(
      { ok: false, error: "נא לפרט מה תרצו לשנות" },
      { status: 400 },
    );
  }

  // The chip first — it's the state the team sees on the card, and it
  // must survive even if the discussion post below can't be made.
  await upsertPrisotChangeRequest({
    fileId,
    projectName: request.projectName,
    requestedBy: email,
    note,
  });
  await resolvePrisaApprovalRequest({
    fileId,
    resolution: "changes",
    resolvedBy: email,
  });

  // Post into the project's SHARED discussion so the team gets the note
  // through the usual channel (which also fires the office-Chat signal).
  // This can legitimately fail: createMentionDirect runs
  // assertProjectAccess, and an ad-hoc recipient who isn't on the
  // project's roster won't pass it. That's not a reason to lose the
  // client's message — fall back to emailing whoever sent the request.
  let posted = false;
  try {
    await createMentionDirect(email, {
      project: request.projectName,
      body: `📐 בקשת שינויים לפריסה:\n${note}`,
      assignees: [],
      scope: "shared",
    });
    posted = true;
  } catch (e) {
    console.warn(
      `[token-action] discussion post failed for ${email} on ${request.projectName}: ${
        e instanceof Error ? e.message : String(e)
      } — falling back to email`,
    );
  }
  if (!posted && request.sentBy) {
    try {
      await sendNotificationEmail({
        fromEmail: driveFolderOwner() || request.sentBy,
        toEmail: request.sentBy,
        subject: `✏️ ${email} ביקש/ה שינויים בפריסה — ${
          request.projectName || request.fileName
        }`,
        plainBody: [
          `${email} ביקש/ה שינויים בפריסה שנשלחה לאישור.`,
          "",
          `פרויקט: ${request.projectName}`,
          `קובץ: ${request.fileName}`,
          "",
          "ההערה:",
          note,
        ].join("\n"),
      });
    } catch (e) {
      console.warn(
        `[token-action] fallback email to ${request.sentBy} failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  return NextResponse.json({ ok: true, posted });
}
