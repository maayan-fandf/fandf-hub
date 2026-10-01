import { NextResponse } from "next/server";
import { parseMeetingBasis } from "@/lib/meetingBasis";
import { generateReportSummary } from "@/lib/reportAiSummary";
import { requireTeam } from "@/lib/viewerGate";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/report/ai-summary  Body: { project, period?, company?, basis? }
 * On-demand AI performance summary for the native report. Internal viewers
 * only — staff, and the team members Keys lists under an outside address
 * (requireTeam); never a client. Nothing here is personal to the caller:
 * the summary is built from the shared report data, so the domain is not
 * the test. The result is 6h-cached server-side (see lib/reportAiSummary).
 *
 * `basis` is the page-level meeting switch's EFFECTIVE basis ("lead" |
 * "dated"). Anything else — absent, garbage, a stale client that predates
 * the switch — is lead-entry, the page's default, via parseMeetingBasis.
 */
export async function POST(req: Request) {
  const gate = await requireTeam();
  if (gate instanceof NextResponse) return gate;
  let body: { project?: unknown; period?: unknown; company?: unknown; basis?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const project = String(body.project || "").trim();
  const period = String(body.period || "").trim();
  const company = String(body.company || "").trim();
  const basis = parseMeetingBasis(body.basis);
  if (!project) {
    return NextResponse.json({ ok: false, error: "project required" }, { status: 400 });
  }
  try {
    const text = await generateReportSummary(project, period, company, basis);
    if (!text) {
      return NextResponse.json(
        { ok: false, error: "לא התקבל סיכום — ייתכן שאין מספיק נתונים או שמפתח ה-AI לא מוגדר." },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true, text });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
