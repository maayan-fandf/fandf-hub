import { NextRequest, NextResponse } from "next/server";
import { searchContent } from "@/lib/appsScript";
import { requireViewer } from "@/lib/viewerGate";

/**
 * Content search. Proxies to the Apps Script `search` action, which scans
 * Comments filtered to projects the user has access to. Meant to be called
 * from the command palette — debounce on the client, we don't cache here.
 *
 * Open to every hub viewer, clients included — the palette is mounted for
 * all of them (app/layout.tsx) and the script scopes hits to the caller's
 * projects. The gate only makes "who is asking" explicit up front.
 */
export async function GET(req: NextRequest) {
  const gate = await requireViewer();
  if (gate instanceof NextResponse) return gate;

  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  const limitRaw = req.nextUrl.searchParams.get("limit");
  const limit = limitRaw ? Math.max(1, Math.min(100, parseInt(limitRaw, 10) || 30)) : 30;

  if (!q) {
    return NextResponse.json({ query: "", results: [], total: 0 });
  }
  if (q.length < 2) {
    return NextResponse.json({ query: q, results: [], total: 0 });
  }

  try {
    const data = await searchContent(q, limit);
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
