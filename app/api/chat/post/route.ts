import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { auth } from "@/auth";
import { postMessage, parseSpaceId, listThreadMentionedEmails } from "@/lib/chat";
import { readKeysCached, findChatSpaceColumnIndex } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TEXT = 4000;

/**
 * Hub-side composer endpoint for the internal Chat tab. Posts a Chat
 * message into the project's space, impersonating the session user
 * (so the message appears authored by them, not by a bot identity).
 *
 * Authorization: NextAuth session must be active. We don't gate by
 * project access here because the underlying Chat API call already
 * gates — if the impersonated user isn't a member of the space, the
 * post fails. That's both correct AND the simplest model.
 *
 * On success, calls revalidateTag("chat-messages") so the next read
 * of the internal tab picks up the new message immediately rather
 * than waiting up to 60s for the listRecentMessages cache to expire.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }

  let body: {
    project?: string;
    /** Disambiguator for non-unique project names (כללי has 4 rows,
     *  one per company). Threaded from the project page's
     *  `?company=…` URL through the composer. Optional for back-
     *  compat with any caller that doesn't have it; falls back to
     *  first-by-name match. */
    company?: string;
    text?: string;
    threadName?: string;
    mentions?: { email: string; name: string }[];
    attachments?: { resourceName: string }[];
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Expected JSON body" },
      { status: 400 },
    );
  }

  const project = String(body.project || "").trim();
  const company = String(body.company || "").trim();
  const text = String(body.text || "").trim();
  const threadName = String(body.threadName || "").trim();
  const mentions = Array.isArray(body.mentions)
    ? body.mentions
        .filter(
          (m) =>
            m &&
            typeof m.email === "string" &&
            typeof m.name === "string" &&
            m.email.includes("@") &&
            m.name.length > 0,
        )
        .slice(0, 30) // sanity cap — Chat's annotation limit is way higher
    : [];
  const attachments = Array.isArray(body.attachments)
    ? body.attachments
        .filter(
          (a) =>
            a &&
            typeof a.resourceName === "string" &&
            a.resourceName.length > 0,
        )
        .slice(0, 10)
    : [];
  if (!project) {
    return NextResponse.json(
      { ok: false, error: "project is required" },
      { status: 400 },
    );
  }
  // Allow empty text when there's at least one attachment — useful
  // when the user just wants to drop an image with no caption.
  if (!text && attachments.length === 0) {
    return NextResponse.json(
      { ok: false, error: "text or attachments required" },
      { status: 400 },
    );
  }
  if (text.length > MAX_TEXT) {
    return NextResponse.json(
      { ok: false, error: `Text too long (max ${MAX_TEXT} chars)` },
      { status: 413 },
    );
  }

  // Resolve the project's Chat space ID from Keys col L. When the
  // caller supplies `company`, match the (project, company) tuple
  // strictly — this is the same disambiguation pattern createChatSpace
  // uses, and prevents the 2026-05-03 bug where posting on כללי under
  // company X picked up a different כללי row's webhook (or empty,
  // surfacing as "project not configured" even though the user just
  // created the space). Falls back to first-by-name when company is
  // absent (legacy callers).
  let webhookUrl = "";
  try {
    const { headers, rows } = await readKeysCached(session.user.email);
    const iProj = headers.indexOf("פרוייקט");
    const iCo = headers.indexOf("חברה");
    const iWebhook = findChatSpaceColumnIndex(headers);
    if (iProj < 0 || iWebhook < 0) {
      return NextResponse.json(
        { ok: false, error: "Keys missing פרוייקט / Chat Space columns" },
        { status: 500 },
      );
    }
    const target = project.toLowerCase().trim();
    const targetCo = company.toLowerCase().trim();
    let firstByName = "";
    for (const row of rows) {
      if (String(row[iProj] ?? "").toLowerCase().trim() !== target) continue;
      const w = String(row[iWebhook] ?? "").trim();
      if (!firstByName) firstByName = w;
      if (!targetCo) {
        webhookUrl = w;
        break;
      }
      if (
        iCo >= 0 &&
        String(row[iCo] ?? "").toLowerCase().trim() === targetCo
      ) {
        webhookUrl = w;
        break;
      }
    }
    // companyHint provided but no exact (project, company) match — keep
    // empty (the caller's company was wrong, or the row was deleted);
    // do NOT fall back to first-by-name. Posting to a sibling company's
    // space silently is much worse than a clear "not configured" error.
    if (!webhookUrl && !targetCo) {
      webhookUrl = firstByName;
    }
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: "Keys lookup failed: " + (e instanceof Error ? e.message : String(e)),
      },
      { status: 500 },
    );
  }
  const spaceId = parseSpaceId(webhookUrl);
  if (!spaceId) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Project is not configured with a Chat space. Set Keys col L (Chat Space) for this project.",
      },
      { status: 400 },
    );
  }

  // Post as the session user. If they're not a member of the space,
  // the Chat API will return 403 / 404 — surface the underlying error
  // verbatim so the user sees something actionable.
  // threadName (when provided) makes this a reply within an existing
  // thread; otherwise it starts a new top-level thread.
  // mentions (when non-empty) trigger programmatic USER_MENTION
  // annotations on the posted message — that's what makes Chat fire
  // a real notification to the @-mentioned user.
  const messageName = await postMessage(
    session.user.email,
    spaceId,
    text,
    {
      threadName: threadName || undefined,
      mentions,
      attachments: attachments.length > 0 ? attachments : undefined,
    },
  );
  if (!messageName) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Failed to post message. Check that you're a member of the project's Chat space.",
      },
      { status: 500 },
    );
  }

  // Bust the listRecentMessages cache so the next page render shows
  // the new message without waiting for the 60s TTL.
  revalidateTag("chat-messages");

  // Hub-side notification fan-out. Two pools (deduped by email):
  //
  //   (1) Explicit @-mentions on THIS message — the picker-injected
  //       USER_MENTION annotations. Always notified.
  //   (2) When this is a reply (threadName set), every email that was
  //       @-mentioned anywhere earlier in the same thread. The replier
  //       may not re-tag them but they're conversationally invested,
  //       and Chat doesn't auto-CC mentioned-earlier users. Resolved
  //       via Directory API gaia → email lookup.
  //
  // Self-mentions filtered inside notifyOnce. Best-effort: failures
  // are logged inside the lib and don't block the response.
  const recipients = new Set<string>();
  for (const m of mentions) {
    const e = (m.email || "").toLowerCase().trim();
    if (e) recipients.add(e);
  }
  if (threadName) {
    try {
      const threadEmails = await listThreadMentionedEmails(
        session.user.email,
        spaceId,
        threadName,
      );
      for (const e of threadEmails) recipients.add(e);
    } catch (e) {
      console.log("[chat/post] thread-participant lookup failed:", e);
    }
  }
  if (recipients.size > 0) {
    const base = (process.env.AUTH_URL || "").replace(/\/+$/, "");
    const link = base
      ? `${base}/projects/${encodeURIComponent(project)}?channel=internal`
      : "";
    const { notifyOnce } = await import("@/lib/notifications");
    const bodyPreview = text.slice(0, 280);
    await Promise.all(
      Array.from(recipients).map((email) =>
        notifyOnce({
          kind: "chat_mention",
          forEmail: email,
          actorEmail: session.user!.email!,
          project,
          title: project,
          body: bodyPreview,
          link,
        }),
      ),
    );
  }

  return NextResponse.json({ ok: true, messageName });
}
