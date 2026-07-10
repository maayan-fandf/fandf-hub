import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { generateReportSummary } from "@/lib/reportAiSummary";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/report/ai-summary  Body: { project, period?, company? }
 * On-demand AI performance summary for the native report (internal
 * @fandf.co.il users only — mirrors the legacy admin/owns-project gate,
 * but the whole native report is already internal-gated on the page).
 * The result is 6h-cached server-side (see lib/reportAiSummary).
 */
export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email?.toLowerCase().trim() ?? "";
  if (!email.endsWith("@fandf.co.il")) {
    return NextResponse.json({ ok: false, error: "Not authorized" }, { status: 403 });
  }
  let body: { project?: unknown; period?: unknown; company?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const project = String(body.project || "").trim();
  const period = String(body.period || "").trim();
  const company = String(body.company || "").trim();
  if (!project) {
    return NextResponse.json({ ok: false, error: "project required" }, { status: 400 });
  }
  try {
    const text = await generateReportSummary(project, period, company);
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
