import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { auth } from "@/auth";
import { postMessage, parseSpaceId } from "@/lib/chat";
import { readKeysCached } from "@/lib/keys";

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

  let body: { project?: string; text?: string };
  try {
    body = (await req.json()) as { project?: string; text?: string };
  } catch {
    return NextResponse.json(
      { ok: false, error: "Expected JSON body" },
      { status: 400 },
    );
  }

  const project = String(body.project || "").trim();
  const text = String(body.text || "").trim();
  if (!project || !text) {
    return NextResponse.json(
      { ok: false, error: "project and text are required" },
      { status: 400 },
    );
  }
  if (text.length > MAX_TEXT) {
    return NextResponse.json(
      { ok: false, error: `Text too long (max ${MAX_TEXT} chars)` },
      { status: 413 },
    );
  }

  // Resolve the project's Chat space ID from Keys col L. Same lookup
  // path InternalDiscussionTab uses for read — single source of truth.
  let webhookUrl = "";
  try {
    const { headers, rows } = await readKeysCached(session.user.email);
    const iProj = headers.indexOf("פרוייקט");
    const iWebhook = headers.indexOf("Chat Webhook");
    if (iProj < 0 || iWebhook < 0) {
      return NextResponse.json(
        { ok: false, error: "Keys missing פרוייקט / Chat Webhook columns" },
        { status: 500 },
      );
    }
    const target = project.toLowerCase().trim();
    for (const row of rows) {
      if (String(row[iProj] ?? "").toLowerCase().trim() === target) {
        webhookUrl = String(row[iWebhook] ?? "").trim();
        break;
      }
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
          "Project is not configured with a Chat space. Set Keys col L (Chat Webhook) for this project.",
      },
      { status: 400 },
    );
  }

  // Post as the session user. If they're not a member of the space,
  // the Chat API will return 403 / 404 — surface the underlying error
  // verbatim so the user sees something actionable.
  const messageName = await postMessage(session.user.email, spaceId, text);
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

  return NextResponse.json({ ok: true, messageName });
}
