import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { createMentionDirect } from "@/lib/commentsWriteDirect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TEXT = 4000;

/**
 * Share a customer-email summary to a project's client-facing comment
 * thread. Posts a Comments-sheet row visible to clients on the
 * project page's "client" tab — the surface used by the in-page
 * `+ הודעה ללקוח` composer (ClientChatComposer).
 *
 * Different mechanism than share-to-chat (which posts to the project's
 * Google Chat Space, team-only). This one writes to the hub's
 * Comments sheet via the same path /api/tasks/create takes:
 * createMentionDirect with empty assignees + no due date = a comment,
 * not a task.
 *
 * Caller picks the project explicitly.
 */
export async function POST(req: Request) {
  const session = await auth();
  const me = session?.user?.email;
  if (!me) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }

  let body: {
    project?: string;
    subject?: string;
    sender?: string;
    senderName?: string;
    snippet?: string;
    gmailLink?: string;
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
  if (!project) {
    return NextResponse.json(
      { ok: false, error: "project is required" },
      { status: 400 },
    );
  }

  // Compose the message — same shape as the share-to-chat endpoint.
  // Comments sheet doesn't render Markdown but the ASCII formatting
  // (📧 prefix, blank lines, 🔗 link) reads cleanly anyway.
  const lines: string[] = [];
  const subject = String(body.subject || "").trim();
  const senderName = String(body.senderName || "").trim();
  const sender = String(body.sender || "").trim();
  const snippet = String(body.snippet || "").trim();
  const gmailLink = String(body.gmailLink || "").trim();
  lines.push("📧 העברה לתיעוד מתוך מייל מהלקוח");
  if (subject) lines.push(subject);
  if (senderName || sender) {
    lines.push(`מאת: ${senderName ? `${senderName} <${sender}>` : sender}`);
  }
  if (snippet) lines.push("", snippet.slice(0, 800));
  if (gmailLink) lines.push("", gmailLink);
  let text = lines.join("\n");
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT - 1) + "…";

  try {
    const result = await createMentionDirect(me, {
      project,
      body: text,
      assignees: [], // empty = comment, not a task
      due: "",
    });
    return NextResponse.json({
      ...result,
      ok: true,
      projectName: project,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
