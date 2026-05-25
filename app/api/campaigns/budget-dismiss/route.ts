import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { canSeeCampaigns } from "@/lib/userRole";
import { upsertAlertDismissal } from "@/lib/alertDismissals";
import {
  pacingPlatformKey,
  pacingChannelKey,
  type Platform,
} from "@/lib/budgetTypes";

export const dynamic = "force-dynamic";

/**
 * POST /api/campaigns/budget-dismiss
 * Body: { slug, platform, baselineDaily, restore? }
 *
 * "טיפלתי" snooze on a project×platform pacing alert. Writes the ONE
 * shared signal_key (`<slug>|pacing-variance|platform|<platform>`) into
 * the Firestore alertDismissals store, so the same dismissal also fades
 * the morning feed alert and the dashboard project-page pacing cell. The
 * platform's summed actual daily budget at snooze time is recorded in
 * `reason` (baseline=N) so all surfaces can self-resurface the alert the
 * next day if the budget DIDN'T actually change after Supermetrics ran
 * overnight (see computeFadeState in BudgetGrid).
 *
 * restore=true clears the snooze (snooze_until="") → un-fades it.
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
    platform?: unknown;
    channel?: unknown;
    baselineDaily?: unknown;
    restore?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const slug = String(body.slug || "").trim();
  const platform = String(body.platform || "").trim().toLowerCase();
  const channel = String(body.channel || "").trim();
  if (!slug || (!channel && !platform)) {
    return NextResponse.json({ ok: false, error: "slug + channel required" }, { status: 400 });
  }
  const baseline = Number(body.baselineDaily);
  const restore = body.restore === true;

  // Per-channel snooze (2026-05-25). The legacy per-platform key is kept
  // as a fallback for any caller that still sends only `platform`.
  const signalKey = channel
    ? pacingChannelKey(slug, channel)
    : pacingPlatformKey(slug, platform as Platform | "other");

  // Pacing spend swings daily — snooze ~1 day (matches the morning feed's
  // pacing-variance default) so an unhandled alert resurfaces tomorrow.
  // The baseline check (computeFadeState) keeps it faded past then only
  // when the budget actually changed.
  const until = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

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
