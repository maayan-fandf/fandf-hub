import { NextResponse } from "next/server";
import { currentUserEmail } from "@/lib/appsScript";
import { getEffectiveViewAs } from "@/lib/viewAsCookie";
import { getMyProjectsDirect } from "@/lib/projectsDirect";
import { resolveGa4Target } from "@/lib/ga4Project";
import { fetchCityCampaigns } from "@/lib/ga4Report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Which campaigns brought traffic to one city, for the map drill-down.
 *
 * Fetched on demand rather than shipped with the section: the full
 * matrix is every city (100+ on a busy property) x every campaign, which
 * is both a large payload and a large GA response for something the
 * viewer usually never opens. One city at a time is a single filtered
 * report.
 *
 * Client-visible, so project access is re-derived from Keys on every
 * call rather than trusted from the query string — same gate as
 * /api/analytics/live.
 */
export async function GET(req: Request) {
  const sessionEmail = await currentUserEmail().catch(() => "");
  if (!sessionEmail) {
    return NextResponse.json({ ok: false, reason: "unauthenticated" }, { status: 401 });
  }

  const url = new URL(req.url);
  const project = (url.searchParams.get("project") ?? "").trim();
  const city = (url.searchParams.get("city") ?? "").trim();
  const start = (url.searchParams.get("start") ?? "").trim();
  const end = (url.searchParams.get("end") ?? "").trim();
  if (!project || !city) {
    return NextResponse.json({ ok: false, reason: "bad-request" }, { status: 400 });
  }
  // Dates come from the client, so they are validated rather than passed
  // through into a GA query verbatim.
  const isoRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!isoRe.test(start) || !isoRe.test(end)) {
    return NextResponse.json({ ok: false, reason: "bad-range" }, { status: 400 });
  }

  try {
    const viewAs = await getEffectiveViewAs(sessionEmail).catch(() => "");
    const email = viewAs && viewAs !== sessionEmail ? viewAs : sessionEmail;

    const mine = await getMyProjectsDirect(email);
    if (!mine.projects.some((p) => p.name === project)) {
      return NextResponse.json({ ok: false, reason: "forbidden" }, { status: 403 });
    }

    const target = await resolveGa4Target(email, project);
    if (!target) return NextResponse.json({ ok: false, reason: "no-property" });

    const rows = await fetchCityCampaigns(
      target.propertyId,
      target.paths,
      city,
      { start, end },
    );
    return NextResponse.json({ ok: true, city, rows });
  } catch (e) {
    console.log(
      "[analytics/city] failed:",
      e instanceof Error ? e.message : String(e),
    );
    return NextResponse.json({ ok: false, reason: "error" });
  }
}
