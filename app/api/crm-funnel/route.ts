import { NextResponse } from "next/server";
import { getCrmFunnelForProject, funnelByCanonicalChannel } from "@/lib/crmData";

export const dynamic = "force-dynamic";

/**
 * Server-to-server CRM-funnel read for the embedded Apps Script report
 * (Client Dashboard). The report's own free-date-range mode can only
 * PRO-RATE leads/scheduled/meetings from the monthly חודשי aggregates
 * (Apps Script has no access to Supabase or the CRM sheet). This endpoint
 * hands it the SAME actual, date-windowed funnel the hub's own CRM card
 * already computes — BMBY from the Supabase warehouse, Salesforce + Sehel
 * from the CRM sheet, all counted on real lead dates inside [from,to].
 *
 *   GET /api/crm-funnel?company=&project=&from=YYYY-MM-DD&to=YYYY-MM-DD
 *     → { ok, funnel: { leads, scheduledMeetings, meetings, contracts },
 *         byChannel: { <canonical-channel>: { leads, scheduled, meetings } },
 *         windowLabel, dataSource }   (funnel:null when no CRM mapping)
 *
 * `byChannel` is the per-canonical-channel funnel split (facebook /
 * google-search / yad2 / …), so the report can attribute REAL per-channel
 * scheduled/held instead of splitting the totals by spend share (which made
 * every channel's CPL/CPS/CPM identical when no pro-rated basis existed).
 *
 * Auth: the shared APPS_SCRIPT_API_TOKEN, sent as the `x-api-token` header
 * (preferred) or `?token=`. No NextAuth session — Apps Script runs
 * unattended. Public path in middleware. Read-only.
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

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  let company = "";
  let project = "";
  let from = "";
  let to = "";
  try {
    const url = new URL(req.url);
    company = (url.searchParams.get("company") || "").trim();
    project = (url.searchParams.get("project") || "").trim();
    from = (url.searchParams.get("from") || "").trim();
    to = (url.searchParams.get("to") || "").trim();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request URL" }, { status: 400 });
  }
  if (!company || !project) {
    return NextResponse.json(
      { ok: false, error: "company and project are required" },
      { status: 400 },
    );
  }
  // The whole point of this endpoint is the free-range path — require a
  // valid inclusive range. Single-month / live views keep computing their
  // own numbers on the report side.
  if (!ISO.test(from) || !ISO.test(to) || from > to) {
    return NextResponse.json(
      { ok: false, error: "from and to must be YYYY-MM-DD with from <= to" },
      { status: 400 },
    );
  }
  try {
    const funnel = await getCrmFunnelForProject({
      company,
      project,
      projectWindow: { from, to },
    });
    if (!funnel) {
      // No Keys.CRM mapping / no matching cohort — let the caller fall
      // back to its pro-rated estimate rather than zeroing the funnel.
      return NextResponse.json({ ok: true, funnel: null });
    }
    const { byChannel } = funnelByCanonicalChannel(funnel.sourceMatrices);
    return NextResponse.json({
      ok: true,
      funnel: {
        leads: funnel.leads,
        scheduledMeetings: funnel.scheduledMeetings,
        meetings: funnel.meetings,
        contracts: funnel.contracts,
      },
      byChannel,
      windowLabel: funnel.windowLabel || "",
      dataSource: funnel.dataSource || "",
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
