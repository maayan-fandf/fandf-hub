import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { auth } from "@/auth";
import { updateMessageText } from "@/lib/chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TEXT = 4000;

/**
 * Edit a Chat message via PATCH. The Chat API only permits a user
 * to edit messages they authored; we enforce that by impersonating
 * the session user — if they didn't author the targeted message,
 * the underlying API call returns 403 and we surface that.
 *
 * Body: { messageName: string, text: string }
 *   messageName — full resource name `spaces/<sid>/messages/<mid>`
 *
 * On success calls revalidateTag("chat-messages") so the next read
 * picks up the edited body without waiting on the 60s TTL.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }

  let body: { messageName?: string; text?: string };
  try {
    body = (await req.json()) as { messageName?: string; text?: string };
  } catch {
    return NextResponse.json(
      { ok: false, error: "Expected JSON body" },
      { status: 400 },
    );
  }

  const messageName = String(body.messageName || "").trim();
  const text = String(body.text || "").trim();
  if (!messageName || !text) {
    return NextResponse.json(
      { ok: false, error: "messageName and text are required" },
      { status: 400 },
    );
  }
  if (!messageName.startsWith("spaces/") || !messageName.includes("/messages/")) {
    return NextResponse.json(
      { ok: false, error: "Invalid messageName" },
      { status: 400 },
    );
  }
  if (text.length > MAX_TEXT) {
    return NextResponse.json(
      { ok: false, error: `Text too long (max ${MAX_TEXT} chars)` },
      { status: 413 },
    );
  }

  try {
    await updateMessageText(session.user.email, messageName, text);
    revalidateTag("chat-messages");
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Chat returns 403 when the caller isn't the author; bubble up
    // the hint so the UI can show something useful.
    return NextResponse.json(
      {
        ok: false,
        error: /permission|forbidden|403/i.test(msg)
          ? "אין הרשאה לערוך — אפשר לערוך רק הודעות שכתבת בעצמך"
          : msg,
      },
      { status: 500 },
    );
  }
}
