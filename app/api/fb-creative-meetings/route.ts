import { NextResponse } from "next/server";
import { getProjectMeetingsLiveMulti } from "@/lib/fbCreativeMeetingsExport";

export const dynamic = "force-dynamic";
// One warehouse project × a few months — bounded; give headroom over the
// default in case the warehouse is slow.
export const maxDuration = 60;

/**
 * Live per-project FB-creative / audience / keyword CRM meetings for the
 * embedded Apps Script report. Replaces the `fb-creative-meetings` /
 * `fb-audience-meetings` / `google-keyword-meetings` Sheet export (which the
 * report used to read): the report now calls this on demand so the per-ad
 * scheduled/held numbers always reflect the Supabase warehouse in real time,
 * with no stale-export window.
 *
 *   GET /api/fb-creative-meetings?project=<warehouse name>&months=YYYY-MM[,YYYY-MM…]
 *     → { ok, project, results: [ { month, creative:[{campaign,ad,leads,scheduled,held}],
 *                                   audience:[{audience,…}], keyword:[{keyword,…}] } ] }
 *
 * `project` is the warehouse project_name (= Keys.CRM account, e.g.
 * "דרימס ארנונה ירושלים") — the same value the old tab's `project` column held.
 * `months` mirrors the report's window (monthsInRange_); each is computed
 * independently so the report can key by month exactly like its lookups do.
 *
 * Auth: shared APPS_SCRIPT_API_TOKEN via `x-api-token` header (preferred) or
 * `?token=`. No NextAuth (Apps Script runs unattended). Public path in
 * middleware. Read-only.
 */
function isAuthorized(req: Request): boolean {
  const expected = process.env.APPS_SCRIPT_API_TOKEN || "";
  if (!expected) return false;
  const header = req.headers.get("x-api-token") || "";
  if (header && header === expected) return true;
  try {
    const url = new URL(req.url);
    if (url.searchParams.get("token") === expected) return true;
  } catch {
    /* ignore malformed URL */
  }
  return false;
}

const MONTH_RE = /^\d{4}-\d{2}$/;

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  let project = "";
  let monthsParam = "";
  try {
    const url = new URL(req.url);
    project = (url.searchParams.get("project") || "").trim();
    monthsParam = (
      url.searchParams.get("months") ||
      url.searchParams.get("month") ||
      ""
    ).trim();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request URL" }, { status: 400 });
  }
  if (!project) {
    return NextResponse.json({ ok: false, error: "project is required" }, { status: 400 });
  }
  const months = monthsParam
    .split(",")
    .map((s) => s.trim())
    .filter((s) => MONTH_RE.test(s));
  if (!months.length) {
    return NextResponse.json(
      { ok: false, error: "months must be one or more YYYY-MM (comma-separated)" },
      { status: 400 },
    );
  }
  if (months.length > 24) {
    return NextResponse.json({ ok: false, error: "too many months (max 24)" }, { status: 400 });
  }
  try {
    // Resolve + fetch meeting-history ONCE, then the per-month leads queries in
    // parallel — the report calls this synchronously on its critical path, so a
    // sequential per-month loop put ~1s/month straight into iframe load time.
    const { results } = await getProjectMeetingsLiveMulti(project, months);
    return NextResponse.json({ ok: true, project, results });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
