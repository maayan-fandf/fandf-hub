import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getAccessScope } from "@/lib/tasksDirect";
import { createCampaignFolder } from "@/lib/driveCampaigns";

export const dynamic = "force-dynamic";

/**
 * POST /api/campaigns/create
 * Body: { project: string, name: string }
 *
 * Creates a Drive folder under `<company>/<project>/<name>` for a new
 * campaign — invoked when the user picks "+ צור בריף חדש" in the
 * picker so the folder is materialized upfront, not deferred to first
 * task save. Idempotent.
 *
 * Access gate: the caller must already have project access (admin or
 * Keys-listed). The folder is owned by DRIVE_FOLDER_OWNER regardless;
 * we just gate which projects you can spawn folders under.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }
  const userEmail = session.user.email;

  let body: { project?: unknown; name?: unknown };
  try {
    body = (await req.json()) as { project?: unknown; name?: unknown };
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }
  const project = String(body.project || "").trim();
  const name = String(body.name || "").trim();
  if (!project) {
    return NextResponse.json(
      { ok: false, error: "project is required" },
      { status: 400 },
    );
  }
  if (!name) {
    return NextResponse.json(
      { ok: false, error: "name is required" },
      { status: 400 },
    );
  }

  try {
    const scope = await getAccessScope(userEmail);
    if (!scope.isAdmin && !scope.accessibleProjects.has(project)) {
      return NextResponse.json(
        { ok: false, error: "Access denied to project: " + project },
        { status: 403 },
      );
    }
    const company = scope.projectCompany.get(project) || "";
    const folder = await createCampaignFolder(userEmail, {
      company,
      project,
      name,
    });
    return NextResponse.json({
      ok: true,
      folder: {
        id: folder.id,
        name: folder.name,
        viewUrl: folder.viewUrl,
        modifiedTime: folder.modifiedTime,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
