import { NextResponse } from "next/server";
import { exportFbCreativeMeetings } from "@/lib/fbCreativeMeetingsExport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Touches ~26 projects (warehouse) + 2 Sheet writes — give it headroom.
export const maxDuration = 300;

/**
 * Cloud Scheduler cron — recompute per-(campaign, ad) + per-(audience) CRM
 * meetings (scheduled/held) for the current month from the BMBY warehouse and
 * write them to the `fb-creative-meetings` / `fb-audience-meetings` tabs of
 * the creative workbook, which the Apps Script report joins onto its FB
 * creative cards + Ad-Sets strip.
 *
 * Auth model: identical to /api/cron/poll-tasks + /api/cron/sync-chat-spaces —
 * the shared secret APPS_SCRIPT_API_TOKEN sent as `X-Cron-Token` (or Bearer).
 * The middleware exempts this path from the NextAuth redirect.
 *
 * Cloud Scheduler: POST https://hub.fandf.co.il/api/cron/fb-creative-meetings
 * with header X-Cron-Token=<APPS_SCRIPT_API_TOKEN> + body "{}", once daily
 * (~06:30 IL, after the ~05:30 warehouse sync).
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
    const res = await exportFbCreativeMeetings();
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
