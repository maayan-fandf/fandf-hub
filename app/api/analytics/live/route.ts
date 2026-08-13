import { NextResponse } from "next/server";
import { currentUserEmail } from "@/lib/appsScript";
import { getEffectiveViewAs } from "@/lib/viewAsCookie";
import { getMyProjectsDirect } from "@/lib/projectsDirect";
import { resolveGa4Target } from "@/lib/ga4Project";
import { fetchLive, fetchWindows } from "@/lib/ga4";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Live GA4 numbers for one project, polled by Ga4LiveSection.
 *
 * This endpoint is CLIENT-VISIBLE, so it re-derives project access from
 * Keys on every call rather than trusting the caller's query string —
 * `getMyProjectsDirect` is the same gate the project page itself uses.
 * A client polling `?project=<someone else's>` gets 403, not data.
 *
 * Quota posture: GA4's realtime token bucket is per-property per-hour
 * and generous; the binding constraint is fan-out, not depth. Each call
 * makes at most 2 realtime + 2 core requests, and the client polls one
 * project at 45s. The title map behind the realtime scoping is cached
 * 6h in-process, so the steady state is 2 realtime calls per poll.
 *
 * Deliberately NOT wrapped in unstable_cache: "real time" and a shared
 * revalidating cache do not mix, and this repo has already been bitten
 * by multi-instance staleness there (feedback_unstable_cache_multi_
 * instance.md).
 */
export async function GET(req: Request) {
  // currentUserEmail (not auth() directly) so local dev honours
  // DEV_USER_EMAIL, matching every other reader in the app.
  const sessionEmail = await currentUserEmail().catch(() => "");
  if (!sessionEmail) {
    return NextResponse.json({ ok: false, reason: "unauthenticated" }, { status: 401 });
  }

  const project = (new URL(req.url).searchParams.get("project") ?? "").trim();
  if (!project) {
    return NextResponse.json({ ok: false, reason: "no-project" }, { status: 400 });
  }

  try {
    const viewAs = await getEffectiveViewAs(sessionEmail).catch(() => "");
    const email = viewAs && viewAs !== sessionEmail ? viewAs : sessionEmail;

    const mine = await getMyProjectsDirect(email);
    const allowed = mine.projects.some((p) => p.name === project);
    if (!allowed) {
      return NextResponse.json({ ok: false, reason: "forbidden" }, { status: 403 });
    }

    const target = await resolveGa4Target(email, project);
    if (!target) {
      return NextResponse.json({ ok: false, reason: "no-property" });
    }

    const [live, windows] = await Promise.all([
      fetchLive(email, target.propertyId, target.paths),
      fetchWindows(email, target.propertyId, target.paths).catch(() => null),
    ]);

    return NextResponse.json({
      ok: true,
      live,
      today: windows?.today ?? null,
      last7: windows?.last7 ?? null,
      source: {
        // Property NAME + host + paths are shown to the viewer so the
        // number is auditable. The numeric property id stays server-side.
        property: target.propertyName,
        host: target.host,
        paths: target.paths,
        via: target.via,
        mode: windows?.mode ?? null,
        conversionPaths: windows?.conversionPaths ?? [],
      },
    });
  } catch (e) {
    console.log(
      "[analytics/live] failed:",
      e instanceof Error ? e.message : String(e),
    );
    return NextResponse.json({ ok: false, reason: "error" });
  }
}
