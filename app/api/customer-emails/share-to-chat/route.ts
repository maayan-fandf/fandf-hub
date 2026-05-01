import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { auth } from "@/auth";
import { postMessage, parseSpaceId } from "@/lib/chat";
import { readKeysCached, findChatSpaceColumnIndex } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TEXT = 4000;

/**
 * Share a customer-email summary to a specific project's Chat Space
 * (Google Chat — the internal-discussion channel for that project).
 *
 * Caller picks the project explicitly. If `project` isn't supplied,
 * falls back to "כללי" (the per-company catchall bucket) and then to
 * the first project under the company that has a chat space — same
 * priority order the picker uses for its default selection.
 *
 * Same auth + impersonation model as /api/chat/post: postMessage runs
 * with the session user's email as the impersonation subject so the
 * message lands authored by them (not a service-account identity).
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

  const company = String(body.company || "").trim();
  const explicitProject = String(body.project || "").trim();
  if (!company && !explicitProject) {
    return NextResponse.json(
      { ok: false, error: "company or project required" },
      { status: 400 },
    );
  }

  // Resolve target project + its Chat Space.
  // Priority: (1) explicit project name from caller, (2) "כללי" under
  // the company, (3) first project under the company that has a chat
  // space configured.
  let projectName = "";
  let chatCellRaw = "";
  try {
    const { headers, rows } = await readKeysCached(me);
    const iCompany = headers.indexOf("חברה");
    const iProject = headers.indexOf("פרוייקט");
    const iChat = findChatSpaceColumnIndex(headers);
    if (iProject < 0 || iChat < 0) {
      return NextResponse.json(
        { ok: false, error: "Keys missing פרוייקט / Chat Space columns" },
        { status: 500 },
      );
    }
    const targetCompany = company.toLowerCase();
    const targetProject = explicitProject.toLowerCase();
    let generalRow: { proj: string; chat: string } | null = null;
    let firstRow: { proj: string; chat: string } | null = null;
    let explicitMatch: { proj: string; chat: string } | null = null;
    for (const row of rows) {
      const proj = String(row[iProject] ?? "").trim();
      const chat = String(row[iChat] ?? "").trim();
      if (!proj || !chat) continue;
      // Scope by company first when supplied. Project names like
      // "כללי" are NOT globally unique — each company has its own,
      // so an explicit-project match has to also be under the target
      // company or we'll post to the wrong company's space.
      if (targetCompany && iCompany >= 0) {
        if (
          String(row[iCompany] ?? "").trim().toLowerCase() !== targetCompany
        )
          continue;
      }
      if (targetProject && proj.toLowerCase() === targetProject) {
        explicitMatch = { proj, chat };
        break;
      }
      if (proj === "כללי" && !generalRow) generalRow = { proj, chat };
      if (!firstRow) firstRow = { proj, chat };
    }
    const chosen = explicitMatch ?? generalRow ?? firstRow;
    if (chosen) {
      projectName = chosen.proj;
      chatCellRaw = chosen.chat;
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
    const where = explicitProject
      ? `project '${explicitProject}'`
      : `company '${company}'`;
    return NextResponse.json(
      {
        ok: false,
        error: `No matching project with a Chat Space found for ${where}.`,
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
