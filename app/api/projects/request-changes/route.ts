import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { createMentionDirect } from "@/lib/commentsWriteDirect";
import { upsertPrisotChangeRequest } from "@/lib/prisotChangeRequests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Client "בקש שינויים" action on the פריסה card. Posts the client's note
 * into the project's SHARED (client-visible) discussion AND records a
 * change-request doc so the card shows a "🔄 התבקשו שינויים" chip until
 * the plan is (re-)approved.
 *
 * The team is alerted through the same path any client message uses:
 * createMentionDirect with scope:"shared" fires the office-Chat
 * cross-stream signal + writes the discussion row the team sees on the
 * project page. Session-auth only; the client's own email is the author
 * and requestedBy (assertProjectAccess inside createMentionDirect gates
 * it to a project they're on).
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

  let body: { project?: string; fileId?: string; note?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid JSON body" },
      { status: 400 },
    );
  }
  const project = String(body.project || "").trim();
  const fileId = String(body.fileId || "").trim();
  const note = String(body.note || "").trim();
  if (!project || !fileId) {
    return NextResponse.json(
      { ok: false, error: "project and fileId required" },
      { status: 400 },
    );
  }
  if (!note) {
    return NextResponse.json(
      { ok: false, error: "note required" },
      { status: 400 },
    );
  }

  try {
    // 1) Post the client-visible discussion message. scope:"shared" is
    //    mandatory (a non-@fandf author can't open an internal thread) and
    //    it fires the office-Chat cross-stream signal so the team is
    //    alerted exactly like any other client message.
    const posted = await createMentionDirect(email, {
      project,
      body: `📐 בקשת שינויים לפריסה:\n${note}`,
      assignees: [],
      scope: "shared",
    });
    // 2) Set the "🔄 התבקשו שינויים" card state (survives until re-approval).
    await upsertPrisotChangeRequest({
      fileId,
      projectName: project,
      requestedBy: email,
      note,
    });
    return NextResponse.json({ ok: true, comment_id: posted.comment_id });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
