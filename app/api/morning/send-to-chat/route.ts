import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { canSeeCampaigns } from "@/lib/userRole";
import { readKeysCached, findChatSpaceColumnIndex } from "@/lib/keys";
import { parseSpaceIdFromWebhook, postMessage } from "@/lib/chat";
import { dismissMorningSignal } from "@/lib/appsScript";

export const dynamic = "force-dynamic";

/**
 * POST /api/morning/send-to-chat
 *
 * Posts a formatted alert summary into a project's internal Google Chat
 * space (the `Chat Space` column on Keys, col L) and then auto-dismisses
 * the alert with `reason="posted_to_chat"` so it dims for the team and
 * doesn't keep firing.
 *
 * Body:
 *   {
 *     signalKey: string,    // for the auto-dismiss
 *     projectName: string,  // resolves the chat space via Keys
 *     severity: "severe"|"warn"|"info",
 *     title: string,        // alert headline
 *     detail: string,       // alert body
 *     url?: string          // optional deep-link the team can click
 *   }
 *
 * Returns: { ok: true, messageName, spaceId, dismissed }
 *
 * Auth: NextAuth session + canSeeCampaigns. Alerts are an internal-team
 * surface; clients can't fire this.
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
  if (!signalKey || !projectName || !title) {
    return NextResponse.json(
      { ok: false, error: "signalKey, projectName and title are required" },
      { status: 400 },
    );
  }

  // Resolve the project's Chat Space (col L, possibly legacy
  // "Chat Webhook"). Keys row matched by the project name in col A.
  let spaceId = "";
  try {
    const { headers, rows } = await readKeysCached(email);
    const iProject = headers.indexOf("פרוייקט");
    const iChat = findChatSpaceColumnIndex(headers);
    if (iProject < 0 || iChat < 0) {
      return NextResponse.json(
        { ok: false, error: "Keys: missing פרוייקט or Chat Space column" },
        { status: 500 },
      );
    }
    const projectRow = rows.find((r) => String(r[iProject] ?? "").trim() === projectName);
    if (!projectRow) {
      return NextResponse.json(
        { ok: false, error: `Project "${projectName}" not found in Keys` },
        { status: 404 },
      );
    }
    const raw = String(projectRow[iChat] ?? "").trim();
    if (!raw) {
      return NextResponse.json(
        {
          ok: false,
          error: "Project has no Chat Space configured. Add a Chat Space link on the Keys sheet.",
        },
        { status: 422 },
      );
    }
    spaceId = parseSpaceIdFromWebhook(raw);
    if (!spaceId) {
      return NextResponse.json(
        { ok: false, error: "Could not parse a Chat space id from the Keys row" },
        { status: 422 },
      );
    }
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }

  // Format the chat message — severity emoji + title + detail + a
  // human-readable "shared by" line + the deep link when present.
  const sevEmoji =
    severity === "severe" ? "🔥" : severity === "warn" ? "⚠️" : "📅";
  const sharedBy = (session?.user?.name || email).split("@")[0];
  const lines = [
    `${sevEmoji} ${title}`,
    detail ? detail : "",
    url ? `🔗 ${url}` : "",
    `— שותף ע״י ${sharedBy} מהלוח של ${projectName}`,
  ].filter(Boolean);
  const text = lines.join("\n");

  let messageName = "";
  try {
    messageName = await postMessage(email, spaceId, text);
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: `Chat post failed: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 502 },
    );
  }
  if (!messageName) {
    return NextResponse.json(
      { ok: false, error: "Chat post returned empty message id" },
      { status: 502 },
    );
  }

  // Auto-snooze the alert so it dims for the team. Default snooze
  // duration (no snoozeUntil passed) — Apps Script applies the
  // per-kind default. Reason tag lets the snoozing flow downstream
  // attribute the dismissal to the chat post, not a manual click.
  let dismissed: unknown = null;
  try {
    dismissed = await dismissMorningSignal({
      signalKey,
      reason: `posted_to_chat:${messageName}`,
    });
  } catch (e) {
    // Don't fail the request — the chat message landed. Just surface
    // the dismiss failure so the UI can show a partial-success state.
    dismissed = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  return NextResponse.json({
    ok: true,
    spaceId,
    messageName,
    dismissed,
  });
}
