import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { canSeeCampaigns } from "@/lib/userRole";
import { getBudgetMaster } from "@/lib/budgetMaster";
import { driveFolderOwner } from "@/lib/sa";

export const dynamic = "force-dynamic";

/**
 * GET /api/campaigns/budget-summary?slug=<projectSlug>
 *
 * Returns the budget-master view for a single project — the same
 * numbers the קמפיינים → תקציבים grid displays — shaped for the
 * dashboard iframe's budget-balance strip:
 *
 *   {
 *     ok: true,
 *     slug, name, e3, allocated, delta, reconStatus,
 *     channels: [{ row, channel, platform, budget, spend, pacingRatio, ended }]
 *   }
 *
 * The iframe POSTs `fandf-get-budget-summary` to the hub; MetricsIframe
 * calls this endpoint and replies via postMessage. We keep the data
 * shaping minimal so any future drift-reallocation logic on the iframe
 * side can compute scores from what's here + the channel performance
 * data it already has from the Apps Script render.
 *
 * Auth: same gate as the budgets surface — admins / managers / media.
 * Clients never see the iframe button that triggers the request, but
 * the gate is enforced server-side too.
 */
export async function GET(req: Request) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }
  const allowed = await canSeeCampaigns(email).catch(() => false);
  if (!allowed) {
    return NextResponse.json(
      { ok: false, error: "Not authorized" },
      { status: 403 },
    );
  }

  const url = new URL(req.url);
  const slug = String(url.searchParams.get("slug") || "").trim();
  if (!slug) {
    return NextResponse.json(
      { ok: false, error: "slug is required" },
      { status: 400 },
    );
  }

  try {
    // The master is React-cached per (subjectEmail) within the request,
    // so multiple lookups on the same page (here, plus the budgets page
    // if it loads) hit the same single read.
    const master = await getBudgetMaster(driveFolderOwner());
    const proj = master.projects.find(
      (p) => p.tab.toLowerCase() === slug.toLowerCase(),
    );
    if (!proj) {
      return NextResponse.json(
        { ok: false, error: `Project tab "${slug}" not found in budget master` },
        { status: 404 },
      );
    }
    return NextResponse.json({
      ok: true,
      slug: proj.tab,
      name: proj.name,
      e3: proj.e3,
      allocated: proj.allocated,
      delta: proj.delta,
      reconStatus: proj.reconStatus,
      totalDays: proj.totalDays,
      remainingDays: proj.remainingDays,
      channels: proj.rows.map((r) => ({
        row: r.row,
        channel: r.channel,
        platform: r.platform,
        budget: r.budget,
        spend: r.spend,
        pacingRatio: r.pacingRatio,
        ended: r.ended,
      })),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
