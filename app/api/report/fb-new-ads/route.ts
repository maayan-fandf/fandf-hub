import { NextResponse } from "next/server";
import { currentUserEmail } from "@/lib/appsScript";
import { getProjectSlug } from "@/lib/campaignMatch";
import { driveFolderOwner } from "@/lib/sa";
import { getNewFbAdsForProject, DEFAULT_HOURS } from "@/lib/fbNewAds";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One Graph call per account, ~0.7s each; the fallback sweep across every
// visible account was measured at 15.5s. Well inside the default, but the
// sweep is the reason this is not left implicit.
export const maxDuration = 60;

/**
 * The רענון button on the Facebook creatives block.
 *
 *   POST /api/report/fb-new-ads  { project, hours?, knownKeys?[] }
 *     → { ok, ads: ReportFbAd[], accounts, sweptAll, hours, failed }
 *
 * ON DEMAND, and unavoidably so. Everything else on the creatives tab is
 * assembled from feeds that refresh on a daily cycle — Supermetrics into
 * the creatives workbook, the nightly warehouse sync, and our own nightly
 * fb-ad-previews cron. None of them knows about an ad launched an hour ago,
 * so "did my ad go up correctly?" cannot be answered by re-reading them,
 * however hard the cache is busted. See lib/fbNewAds.ts.
 *
 * WHO MAY ASK. Staff keep the domain blanket they have everywhere else; a
 * client is checked against getAccessScope for THIS project, the same
 * primitive /api/crm/signed gates on. The caller sends a project NAME and
 * never a slug: the slug is derived here, so nobody can pair a project they
 * may read with another project's campaign patterns and get back that
 * project's ads.
 *
 * Preview links are staff-only, mirroring NativeProjectRail's strip — they
 * only resolve for a viewer holding a Business Manager session anyway, so a
 * client would get a Facebook error page.
 */

/** Per-instance spacing between pulls for one (caller, project).
 *
 *  Not a rate limiter and not sold as one — App Hosting runs several
 *  instances and this Map lives in one of them. It exists for the ordinary
 *  case it actually covers: a stuck key or an impatient double-click firing
 *  a Graph walk per press. Meta's own throttles are the real ceiling. */
const lastCall = new Map<string, number>();
const MIN_SPACING_MS = 5000;

export async function POST(req: Request) {
  const email = await currentUserEmail()
    .then((e) => e.toLowerCase().trim())
    .catch(() => "");
  if (!email) {
    return NextResponse.json({ ok: false, error: "Not authenticated" }, { status: 401 });
  }

  let project = "";
  let hours = DEFAULT_HOURS;
  let knownKeys: Set<string> | undefined;
  try {
    const body = (await req.json()) as {
      project?: unknown;
      hours?: unknown;
      knownKeys?: unknown;
    };
    project = String(body.project ?? "").trim();
    if (body.hours != null && Number.isFinite(Number(body.hours))) {
      hours = Number(body.hours);
    }
    if (Array.isArray(body.knownKeys)) {
      knownKeys = new Set(body.knownKeys.map((k) => String(k).toLowerCase()));
    }
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request body" }, { status: 400 });
  }
  if (!project) {
    return NextResponse.json({ ok: false, error: "project is required" }, { status: 400 });
  }

  const isStaff = email.endsWith("@fandf.co.il");
  if (!isStaff) {
    const { getAccessScope } = await import("@/lib/tasksDirect");
    const scope = await getAccessScope(email).catch(() => null);
    if (!scope || (!scope.isAdmin && !scope.accessibleProjects.has(project))) {
      return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
    }
  }

  const guard = `${email}|${project}`;
  const now = Date.now();
  const prev = lastCall.get(guard) ?? 0;
  if (now - prev < MIN_SPACING_MS) {
    return NextResponse.json(
      { ok: false, error: "too-soon", retryAfterMs: MIN_SPACING_MS - (now - prev) },
      { status: 429 },
    );
  }
  lastCall.set(guard, now);

  try {
    // Keys is read as the folder owner — the same subject the report itself
    // resolves campaigns with, so `mine()` here and `mine()` there cannot
    // disagree about which campaigns belong to the project.
    const owner = driveFolderOwner();
    const slug = await getProjectSlug(owner, project);
    if (!slug) {
      return NextResponse.json({
        ok: true,
        ads: [],
        accounts: [],
        sweptAll: false,
        hours,
        failed: [],
        reason: "no-slug",
      });
    }
    const res = await getNewFbAdsForProject({
      subjectEmail: owner,
      slug,
      hours,
      knownKeys,
      withPreviews: isStaff,
    });
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[report/fb-new-ads] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
