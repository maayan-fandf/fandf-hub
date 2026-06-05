import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { canSeeCampaigns } from "@/lib/userRole";
import { createMentionDirect } from "@/lib/commentsWriteDirect";
import { dismissMorningSignal } from "@/lib/appsScript";

export const dynamic = "force-dynamic";

/**
 * POST /api/morning/send-to-chat
 *
 * Posts a formatted alert summary into the project's INTERNAL team
 * thread (the "פנימי" tab on the project page — Firestore comments
 * with `scope: "internal"`, NOT the old Google Chat). Then auto-
 * dismisses the alert with `reason="posted_to_internal_chat:<id>"`
 * so the row dims for the team and doesn't keep firing.
 *
 * Was originally posting to Google Chat via Keys col L's "Chat Space"
 * link — owner pointed out 2026-06-05 that the Google Chat surface is
 * dead and the active internal chat is the hub's own Comments-tab on
 * the project page. This endpoint keeps the route URL for stability
 * (no frontend change) but swaps the backend.
 *
 * Body:
 *   {
 *     signalKey: string,
 *     projectName: string,
 *     severity: "severe"|"warn"|"info",
 *     title: string,
 *     detail: string,
 *     url?: string
 *   }
 *
 * Returns: { ok, commentId, dismissed }
 *
 * Auth: NextAuth session + canSeeCampaigns. Alerts are an internal-
 * team surface; clients can't fire this. createMentionDirect itself
 * also enforces that only F&F emails may open an internal thread.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json({ ok: false, error: "Not authenticated" }, { status: 401 });
  }
  const allowed = await canSeeCampaigns(email).catch(() => false);
  if (!allowed) {
    return NextResponse.json({ ok: false, error: "Not authorized" }, { status: 403 });
  }

  let body: {
    signalKey?: unknown;
    projectName?: unknown;
    severity?: unknown;
    title?: unknown;
    detail?: unknown;
    url?: unknown;
    assignees?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const signalKey = String(body.signalKey || "").trim();
  const projectName = String(body.projectName || "").trim();
  const severity = String(body.severity || "info").trim();
  const title = String(body.title || "").trim();
  const detail = String(body.detail || "").trim();
  const url = String(body.url || "").trim();
  // Picked teammates from the popover (may be empty — empty selection
  // means a plain channel-wide ping with no specific mentions). De-dup,
  // lower-case, drop the author themselves (self-mentions never notify
  // via createMentionDirect anyway), and drop anything that isn't a
  // valid-looking email — defensive against a malformed client.
  const me = String(email).toLowerCase().trim();
  const rawAssignees = Array.isArray(body.assignees) ? body.assignees : [];
  const assignees = Array.from(
    new Set(
      rawAssignees
        .map((v) => String(v || "").toLowerCase().trim())
        .filter((v) => v && v !== me && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)),
    ),
  );
  if (!signalKey || !projectName || !title) {
    return NextResponse.json(
      { ok: false, error: "signalKey, projectName and title are required" },
      { status: 400 },
    );
  }

  // Format the message — severity emoji + title + detail + deep link.
  // When the user picked teammates in the popover, prepend a line of
  // `@<email>` tokens; CommentBody renders those as avatar chips +
  // Hebrew names, and createMentionDirect ALSO fans out a real
  // mention notification per `assignees` entry. The body tokens make
  // the ping visible at a glance in the rendered comment; the
  // assignees array drives the actual notification side-channel.
  // No "shared by X" line because createMentionDirect stamps the
  // author automatically (the comment carries `created_by`).
  const sevEmoji =
    severity === "severe" ? "🔥" : severity === "warn" ? "⚠️" : "📅";
  const mentionLine =
    assignees.length > 0 ? assignees.map((e) => `@${e}`).join(" ") : "";
  const lines = [
    mentionLine,
    `${sevEmoji} ${title}`,
    detail || "",
    url ? `🔗 ${url}` : "",
    "",
    "_(שותף אוטומטית מההתראות)_",
  ].filter((s) => s.length > 0);
  const text = lines.join("\n");

  let commentId = "";
  try {
    const result = await createMentionDirect(email, {
      project: projectName,
      body: text,
      assignees,
      due: "",
      scope: "internal",
    });
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: "createMentionDirect returned not-ok" },
        { status: 500 },
      );
    }
    commentId = result.comment_id;
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: `Internal chat post failed: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 502 },
    );
  }

  // Auto-snooze the alert so it dims for the team. Apps Script applies
  // the per-kind default snooze duration. Reason carries the comment
  // id so the dismissal can be traced back to the chat post later.
  let dismissed: unknown = null;
  try {
    dismissed = await dismissMorningSignal({
      signalKey,
      reason: `posted_to_internal_chat:${commentId}`,
    });
  } catch (e) {
    // Don't fail the request — the chat post landed. Surface partial.
    dismissed = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  return NextResponse.json({
    ok: true,
    commentId,
    dismissed,
  });
}
