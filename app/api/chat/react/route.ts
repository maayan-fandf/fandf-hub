import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { auth } from "@/auth";
import { addReaction, removeReaction } from "@/lib/chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Add or remove an emoji reaction on a Chat message. The action
 * runs as the session user (so the reaction is attributed to them
 * and the remove path can find their previous reaction to delete).
 *
 * Body: { messageName, emoji, action: "add" | "remove" }
 *   messageName — `spaces/<sid>/messages/<mid>`
 *   emoji       — Unicode codepoint, e.g. "👍"
 *   action      — "add" or "remove"
 *
 * Both actions are idempotent: adding the same emoji twice is a
 * no-op, and removing one that doesn't exist is a no-op. The
 * underlying Chat API enforces this; we just plumb it through.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }

  let body: { messageName?: string; emoji?: string; action?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Expected JSON body" },
      { status: 400 },
    );
  }

  const messageName = String(body.messageName || "").trim();
  const emoji = String(body.emoji || "").trim();
  const action = String(body.action || "").trim();
  if (
    !messageName ||
    !messageName.startsWith("spaces/") ||
    !messageName.includes("/messages/")
  ) {
    return NextResponse.json(
      { ok: false, error: "Invalid messageName" },
      { status: 400 },
    );
  }
  if (!emoji) {
    return NextResponse.json(
      { ok: false, error: "emoji is required" },
      { status: 400 },
    );
  }
  if (action !== "add" && action !== "remove") {
    return NextResponse.json(
      { ok: false, error: "action must be 'add' or 'remove'" },
      { status: 400 },
    );
  }

  try {
    if (action === "add") {
      await addReaction(session.user.email, messageName, emoji);
    } else {
      await removeReaction(session.user.email, messageName, emoji);
    }
    revalidateTag("chat-messages");
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
