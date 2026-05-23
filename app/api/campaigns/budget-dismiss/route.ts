import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { canSeeCampaigns } from "@/lib/userRole";
import { upsertAlertDismissal } from "@/lib/alertDismissals";

export const dynamic = "force-dynamic";

/**
 * POST /api/campaigns/budget-dismiss
 * Body: { slug, channel, campaignType, baselineDaily, restore? }
 *
 * "טיפלתי" snooze on a single budget-desk campaign row. Reuses the
 * existing Firestore alertDismissals store (signal_key prefixed
 * `budget:`). The actual daily budget at snooze time is recorded in
 * `reason` (baseline=N) so the desk can self-resurface the alert the
 * next day if the platform budget DIDN'T actually change after
 * Supermetrics ran overnight (see the fade logic in BudgetGrid).
 *
 * restore=true clears the snooze (snooze_until="") → un-fades the row.
 */
export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json({ ok: false, error: "Not authenticated" }, { status: 401 });
  }
  const allowed = await canSeeCampaigns(email).catch(() => false);
  if (!allowed) {
    return NextResponse.json({ ok: false, error: "Not authorized" }, { status: 403 });
  }

  let body: {
    slug?: unknown;
    channel?: unknown;
    campaignType?: unknown;
    baselineDaily?: unknown;
    restore?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const slug = String(body.slug || "").trim();
  const channel = String(body.channel || "").trim();
  const campaignType = String(body.campaignType || "").trim();
  if (!slug || !channel) {
    return NextResponse.json({ ok: false, error: "slug + channel required" }, { status: 400 });
  }
  const baseline = Number(body.baselineDaily);
  const restore = body.restore === true;

  const signalKey = `budget:${slug}:${channel}:${campaignType}`;

  // Snooze 7 days as an outer bound; the real resurface trigger is the
  // overnight budget-change check, evaluated per-render.
  const until = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

  try {
    const rec = await upsertAlertDismissal({
      user_email: email,
      signal_key: signalKey,
      snooze_until: restore ? "" : until,
      reason: restore
        ? "restored"
        : `baseline=${Number.isFinite(baseline) ? Math.round(baseline) : 0}`,
    });
    return NextResponse.json({
      ok: true,
      signal_key: rec.signal_key,
      snooze_until: rec.snooze_until,
      dismissed_at: rec.dismissed_at,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
