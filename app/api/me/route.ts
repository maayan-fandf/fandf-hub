import { NextResponse } from "next/server";
import { getMyProjects } from "@/lib/appsScript";
import { canSeeCampaigns } from "@/lib/userRole";

/**
 * Light "who am I" for client components that need admin gating (like
 * the admin nav link). Reuses getMyProjects() because it already returns
 * `isAdmin` without requiring an extra Apps Script action. Also
 * computes role-derived predicates (today: canSeeCampaigns) so the
 * top-nav can gate role-specific links without fetching the role
 * client-side. Both reads share the SA → Sheets pipeline; the role
 * lookup is cached per email for 5 min.
 */
export async function GET() {
  try {
    const data = await getMyProjects();
    // canSeeCampaigns is best-effort — failures (Sheets blip, etc.)
    // fall back to false so the link stays hidden rather than flashing
    // for an unauthorized user. Admin already qualifies via the
    // baked-in HUB_ADMIN_EMAILS check inside the helper.
    const cscPromise = data.email
      ? canSeeCampaigns(data.email).catch(() => false)
      : Promise.resolve(false);
    const csc = await cscPromise;
    return NextResponse.json({
      email: data.email,
      isAdmin: data.isAdmin,
      isInternal: data.isInternal,
      canSeeCampaigns: csc,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
