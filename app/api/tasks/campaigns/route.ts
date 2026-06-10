import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getTaskCampaigns } from "@/lib/appsScript";

export const dynamic = "force-dynamic";

/**
 * GET /api/tasks/campaigns?project=<name>
 *
 * Returns distinct campaign names that have at least one task on the
 * project, most-recent-first. Feeds the campaign picker's autocomplete
 * in the new-task form + edit panel.
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }

  const url = new URL(req.url);
  const project = (url.searchParams.get("project") || "").trim();
  // Optional company context — required in practice for project names
  // shared across companies (every company has a כללי project).
  // Without it, briefs from other companies' same-named projects leak
  // into the picker.
  const company = (url.searchParams.get("company") || "").trim();
  if (!project) {
    return NextResponse.json(
      { ok: false, error: "project is required" },
      { status: 400 },
    );
  }

  try {
    const result = await getTaskCampaigns(project, company);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
