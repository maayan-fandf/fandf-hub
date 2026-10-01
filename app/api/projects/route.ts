import { NextResponse } from "next/server";
import { getMyProjects } from "@/lib/appsScript";
import { requireViewer } from "@/lib/viewerGate";

/**
 * Thin pass-through of getMyProjects() so client components (the command
 * palette) can lazy-fetch the project list without re-rendering the server
 * layout. We don't cache here — the server-side Apps Script call already
 * uses `cache: "no-store"`.
 */
export async function GET() {
  // Clients use the palette too, so any viewer — but asked here, so nobody
  // signed in off-roster gets a 500 with the lookup's error text instead.
  const gate = await requireViewer();
  if (gate instanceof NextResponse) return gate;
  try {
    const data = await getMyProjects();
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
