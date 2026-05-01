import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { auth } from "@/auth";
import { postMessage, parseSpaceId } from "@/lib/chat";
import { readKeysCached, findChatSpaceColumnIndex } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TEXT = 4000;

/**
 * Share a customer-email summary to the relevant project's Chat Space
 * so the team can discuss internally without leaving the hub.
 *
 * Resolution path:
 *   sender's company (from the row, already resolved client-side)
 *     → first project row in Keys with that company
 *     → that project's Chat Space (col L)
 *   → impersonate the session user, post the formatted message.
 *
 * Why first project: a single client-company can have multiple
 * projects. Without an explicit picker, "first by sheet order" is the
 * pragmatic default — usually it's the active one. If users find
 * themselves needing to pick, we'll add a project selector to the
 * popover row in v0.5.
 *
 * Same auth + impersonation model as /api/chat/post — we delegate to
 * postMessage with the session user's email as subject, which means
 * the message lands authored by them (not a service account).
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
    company?: string;
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

  const company = String(body.company || "").trim();
  if (!company) {
    return NextResponse.json(
      { ok: false, error: "company is required" },
      { status: 400 },
    );
  }

  // Resolve company → first project + its Chat Space.
  let projectName = "";
  let chatCellRaw = "";
  try {
    const { headers, rows } = await readKeysCached(me);
    const iCompany = headers.indexOf("חברה");
    const iProject = headers.indexOf("פרוייקט");
    const iChat = findChatSpaceColumnIndex(headers);
    if (iCompany < 0 || iProject < 0 || iChat < 0) {
      return NextResponse.json(
        { ok: false, error: "Keys missing חברה / פרוייקט / Chat Space columns" },
        { status: 500 },
      );
    }
    const target = company.toLowerCase();
    for (const row of rows) {
      if (String(row[iCompany] ?? "").trim().toLowerCase() !== target) continue;
      const proj = String(row[iProject] ?? "").trim();
      const chat = String(row[iChat] ?? "").trim();
      if (proj && chat) {
        projectName = proj;
        chatCellRaw = chat;
        break;
      }
    }
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Keys lookup failed: " +
          (e instanceof Error ? e.message : String(e)),
      },
      { status: 500 },
    );
  }

  if (!projectName) {
    return NextResponse.json(
      {
        ok: false,
        error: `No project under company '${company}' has a Chat Space configured.`,
      },
      { status: 400 },
    );
  }
  const spaceId = parseSpaceId(chatCellRaw);
  if (!spaceId) {
    return NextResponse.json(
      {
        ok: false,
        error: `Project '${projectName}' Chat Space cell is set but unparseable.`,
      },
      { status: 400 },
    );
  }

  // Compose the message. Subject + sender + snippet + Gmail link, kept
  // compact so the team's chat doesn't drown in pasted-email walls.
  const lines: string[] = [];
  const subject = String(body.subject || "").trim();
  const senderName = String(body.senderName || "").trim();
  const sender = String(body.sender || "").trim();
  const snippet = String(body.snippet || "").trim();
  const gmailLink = String(body.gmailLink || "").trim();
  lines.push("📧 *מייל חדש מלקוח לדיון פנימי*");
  if (subject) lines.push(`*${subject}*`);
  if (senderName || sender) {
    lines.push(`מאת: ${senderName ? `${senderName} <${sender}>` : sender}`);
  }
  if (snippet) lines.push("", snippet.slice(0, 500));
  if (gmailLink) lines.push("", `🔗 ${gmailLink}`);
  let text = lines.join("\n");
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT - 1) + "…";

  const messageName = await postMessage(me, spaceId, text, {});
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

  // Bust the InternalDiscussionTab cache so the team sees the new
  // message immediately if they're already on the project page.
  revalidateTag("chat-messages");

  return NextResponse.json({ ok: true, projectName, messageName });
}
