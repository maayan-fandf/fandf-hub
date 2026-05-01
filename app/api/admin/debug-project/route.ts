import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { auth } from "@/auth";
import { getMyProjects } from "@/lib/appsScript";
import { parseSpaceId } from "@/lib/chat";
import { HUB_ADMIN_EMAILS } from "@/lib/tasksDirect";

/**
 * Admin diagnostic for "/projects/<name> shows the empty-state when I
 * know the chat URL is in Keys" mysteries. Returns the resolved
 * Project for the requested name as the production page sees it,
 * plus the parsed space id — so we can tell whether the empty state
 * is a stale cache, a parse failure, or an actual lookup miss.
 *
 * Optional ?bust=1 calls revalidateTag for keys + my-projects
 * before doing the lookup, so the response reflects fresh state.
 *
 * Hardcoded admin gate (HUB_ADMIN_EMAILS) — the endpoint exposes
 * resolved roster data so it shouldn't be open to all users.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await auth();
  const email = session?.user?.email?.toLowerCase().trim() ?? "";
  if (!email || !HUB_ADMIN_EMAILS.has(email)) {
    return NextResponse.json({ ok: false, error: "admin only" }, { status: 403 });
  }
  const url = new URL(req.url);
  const name = url.searchParams.get("name") ?? "";
  const bust = url.searchParams.get("bust") === "1";
  if (!name) {
    return NextResponse.json({ ok: false, error: "missing ?name=" }, { status: 400 });
  }

  if (bust) {
    revalidateTag("keys");
    revalidateTag("my-projects");
  }

  const data = await getMyProjects().catch((e) => ({ error: String(e) }));
  if ("error" in data && !("projects" in data)) {
    return NextResponse.json({ ok: false, busted: bust, ...data });
  }
  const projects = (data as { projects: { name: string; company: string; chatSpaceUrl: string }[] }).projects;
  const matches = projects.filter((p) => p.name === name);
  const found = projects.find((p) => p.name === name);
  return NextResponse.json({
    ok: true,
    busted: bust,
    requestedName: name,
    requestedNameCodepoints: [...name].map((c) => c.codePointAt(0)?.toString(16)).join(" "),
    matchCount: matches.length,
    matches: matches.map((m) => ({
      name: m.name,
      nameCodepoints: [...m.name].map((c) => c.codePointAt(0)?.toString(16)).join(" "),
      company: m.company,
      chatSpaceUrl: m.chatSpaceUrl,
      parsedSpaceId: parseSpaceId(m.chatSpaceUrl),
    })),
    foundFirstMatch: found
      ? {
          name: found.name,
          company: found.company,
          chatSpaceUrl: found.chatSpaceUrl,
          parsedSpaceId: parseSpaceId(found.chatSpaceUrl),
        }
      : null,
  });
}
