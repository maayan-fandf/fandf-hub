import { NextResponse } from "next/server";
import { exportFbAdPreviews } from "@/lib/fbAdPreviewsExport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Incremental runs touch a few hundred ads across 23 accounts. The FULL walk
// is ~30,600 ads and about four minutes, which does not fit here — seed the
// tab from a workstation instead (see the lib's doc block).
export const maxDuration = 300;

/**
 * Cloud Scheduler cron — refresh the ad-preview links ("צפייה במודעה") from
 * the Meta Graph API into the `fb-ad-previews` tab of the creatives workbook,
 * which lib/reportCreatives.ts joins onto its FB creative cards.
 *
 * WHY A CRON AND NOT A LIVE CALL: a project page would need one Graph round
 * trip per account to answer, and the links change only when an ad does.
 *
 * Auth model: identical to the sibling crons — the shared secret
 * APPS_SCRIPT_API_TOKEN as `X-Cron-Token` (or Bearer). The path must ALSO be
 * added to middleware.ts's allowlist, or the request is redirected to the
 * login page and Cloud Scheduler records a cheerful 200 for the HTML of a
 * sign-in form.
 *
 * Cloud Scheduler: POST https://hub.fandf.co.il/api/cron/fb-ad-previews
 * with header X-Cron-Token=<APPS_SCRIPT_API_TOKEN> and body "{}", once daily.
 *
 * `?full=1` forces the whole walk. Only useful from a machine with no
 * request timeout; the cron itself should never pass it.
 */
export async function POST(req: Request) {
  const expected = process.env.APPS_SCRIPT_API_TOKEN || "";
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "APPS_SCRIPT_API_TOKEN not configured" },
      { status: 500 },
    );
  }
  const auth = req.headers.get("authorization") || "";
  const token =
    req.headers.get("x-cron-token") ||
    (auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "");
  if (token !== expected) {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  let full = false;
  try {
    full = new URL(req.url).searchParams.get("full") === "1";
  } catch {
    /* keep the default */
  }

  try {
    const res = await exportFbAdPreviews({ full });
    // A per-account failure is reported, not thrown: twenty-two accounts
    // refreshing is a better outcome than none, and the count is what tells
    // anyone reading the scheduler log that something needs looking at.
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[cron/fb-ad-previews] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
