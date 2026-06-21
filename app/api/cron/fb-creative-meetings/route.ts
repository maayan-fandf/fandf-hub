import { NextResponse } from "next/server";
import { exportFbCreativeMeetings } from "@/lib/fbCreativeMeetingsExport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Touches ~26 projects (warehouse) × N months + 2 Sheet writes each — headroom.
export const maxDuration = 300;

/** The last `n` calendar months (Asia/Jerusalem), newest first: ["2026-06","2026-05"]. */
function lastNMonthsIL(n: number): string[] {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  let y = Number(p.find((x) => x.type === "year")!.value);
  let m = Number(p.find((x) => x.type === "month")!.value);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m--;
    if (m < 1) { m = 12; y--; }
  }
  return out;
}

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
    // Refresh the current month AND the previous one. The tab is per-month
    // history (writeTab merges by month), so this keeps a just-ended month
    // fresh as its leads' meetings get scheduled/held in the following weeks,
    // without disturbing older backfilled months.
    const months = lastNMonthsIL(2);
    const results = [];
    for (const m of months) results.push(await exportFbCreativeMeetings(m));
    return NextResponse.json({ ok: true, months: results });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
