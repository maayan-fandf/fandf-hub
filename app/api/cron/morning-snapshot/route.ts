import { NextResponse } from "next/server";
import { refreshMorningSnapshot } from "@/lib/appsScript";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The whole point of this route is to absorb the slow call, so give it
// room. Apps Script aborts itself at 170s (ACTION_TIMEOUT_MS.morningFeed)
// and the observed median is ~124s, but the tail has been seen past 230s;
// this ceiling is for the Cloud Run request around it, not the fetch.
export const maxDuration = 300;

/**
 * Cron entry point — refreshes the precomputed portfolio morning feed
 * so no user request ever waits on Apps Script's `_morningFeed_`.
 * See lib/morningSnapshot.ts for the measurements and the argument for
 * one global doc.
 *
 * Auth model: identical to the other cron routes — the shared-secret
 * APPS_SCRIPT_API_TOKEN sent as `X-Cron-Token` (or Bearer).
 *
 * Cloud Scheduler setup (owner runs this; the SA has
 * roles/cloudscheduler.viewer only, which is read-only):
 *
 *   gcloud scheduler jobs create http morning-snapshot \
 *     --location=europe-west4 \
 *     --schedule="*\/15 * * * *" \
 *     --uri=https://hub.fandf.co.il/api/cron/morning-snapshot \
 *     --http-method=POST \
 *     --headers=X-Cron-Token=<APPS_SCRIPT_API_TOKEN> \
 *     --message-body='{}' \
 *     --attempt-deadline=300s
 *
 * `--attempt-deadline=300s` matters: Scheduler's default is 180s, which
 * is BELOW the observed tail and would cancel a healthy run.
 *
 * Cadence is a freshness choice, not a load one. The signals are pacing
 * and funnel shaped and move on a daily rhythm; 15 minutes is already
 * far finer than the data changes. Dismissals do not wait for it —
 * they invalidate the snapshot directly (invalidateMorningSnapshot).
 */
export async function POST(req: Request) {
  const expected = process.env.APPS_SCRIPT_API_TOKEN || "";
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "Server missing APPS_SCRIPT_API_TOKEN" },
      { status: 500 },
    );
  }
  const got =
    req.headers.get("x-cron-token") ||
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    "";
  if (got !== expected) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await refreshMorningSnapshot();
    console.log("[cron/morning-snapshot] result:", JSON.stringify(result));
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A failed refresh is not an outage: readMorningSnapshot serves the
    // previous doc until it ages out, and after that getMorningFeed
    // falls through to the live call. Log loudly, fail the job so the
    // Scheduler status shows it, and leave the last good doc in place.
    console.log("[cron/morning-snapshot] error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

// Allow GET for manual smoke-tests (same auth).
export async function GET(req: Request) {
  return POST(req);
}
