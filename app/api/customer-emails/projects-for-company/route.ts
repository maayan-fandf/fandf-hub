import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { readKeysCached, findChatSpaceColumnIndex } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * List the projects under a given company, with per-project flags the
 * customer-emails picker needs:
 *   - hasChatSpace: Keys col L is non-empty (project has a Google Chat
 *     space configured for the internal-discussion channel)
 *   - isGeneral: project name is exactly "כללי" — the catchall bucket
 *     used when stray work doesn't belong to a specific campaign yet.
 *     The picker pre-selects this when present so unsorted customer
 *     emails land in a sensible default.
 *
 * Sort order matches what the user sees in the projects nav: כללי
 * last (matches the home page's sort-to-bottom convention).
 *
 * Auth: any authenticated session — Keys read goes through the
 * caller's identity so domain access still gates the response. No
 * pref check; this endpoint is also called by the picker itself
 * which is gated by the gmail_customer_poll pref via the parent UI.
 */
export async function GET(req: Request) {
  const session = await auth();
  const me = session?.user?.email;
  if (!me) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }
  const url = new URL(req.url);
  const company = (url.searchParams.get("company") || "").trim();
  if (!company) {
    return NextResponse.json(
      { ok: false, error: "company query param required" },
      { status: 400 },
    );
  }
  try {
    const { headers, rows } = await readKeysCached(me);
    const iCompany = headers.indexOf("חברה");
    const iProject = headers.indexOf("פרוייקט");
    const iChat = findChatSpaceColumnIndex(headers);
    if (iCompany < 0 || iProject < 0) {
      return NextResponse.json(
        { ok: false, error: "Keys missing חברה / פרוייקט columns" },
        { status: 500 },
      );
    }
    const target = company.toLowerCase();
    const seen = new Set<string>();
    const out: { name: string; hasChatSpace: boolean; isGeneral: boolean }[] = [];
    for (const row of rows) {
      if (String(row[iCompany] ?? "").trim().toLowerCase() !== target) continue;
      const name = String(row[iProject] ?? "").trim();
      if (!name) continue;
      // Dedupe by project name within the company — Keys has one row
      // per (company, project, owner) so the same project can appear
      // multiple times. The picker only needs each name once.
      if (seen.has(name)) continue;
      seen.add(name);
      const chat = iChat >= 0 ? String(row[iChat] ?? "").trim() : "";
      out.push({
        name,
        hasChatSpace: !!chat,
        isGeneral: name === "כללי",
      });
    }
    // Sort: real projects first (alphabetical), כללי last. Mirrors
    // the home-page + nav ordering so picker order matches user
    // expectation.
    out.sort((a, b) => {
      if (a.isGeneral !== b.isGeneral) return a.isGeneral ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
    return NextResponse.json({ ok: true, projects: out });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[customer-emails/projects-for-company] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
