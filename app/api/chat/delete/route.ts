import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { auth } from "@/auth";
import { deleteMessage } from "@/lib/chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Delete a Chat message. Author-only — Chat REST returns 403 if the
 * impersonated user (session user) didn't author the message; we
 * surface that hint in Hebrew. revalidateTag busts the 60s message-
 * list cache so the next read no longer shows the deleted row.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }

  let body: { messageName?: string };
  try {
    body = (await req.json()) as { messageName?: string };
  } catch {
    return NextResponse.json(
      { ok: false, error: "Expected JSON body" },
      { status: 400 },
    );
  }

  const messageName = String(body.messageName || "").trim();
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

  try {
    await deleteMessage(session.user.email, messageName);
    revalidateTag("chat-messages");
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      {
        ok: false,
        error: /permission|forbidden|403/i.test(msg)
          ? "אין הרשאה למחוק — אפשר למחוק רק הודעות שכתבת בעצמך"
          : msg,
      },
      { status: 500 },
    );
  }
}
