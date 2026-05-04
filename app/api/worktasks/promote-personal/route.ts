import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { useSATasksWrites } from "@/lib/sa";

/**
 * POST /api/worktasks/promote-personal
 *
 * Promotes a `__personal__` task row to a real project. Validates:
 *   - the task currently lives under a `__` pseudo-project
 *   - the caller is the row's author (only the author can promote — a
 *     collaborator added as an assignee can edit content but not move
 *     the task into a project they may not even have access to)
 *   - the caller has write access to the new project (delegated to
 *     `assertProjectAccess` via the standard tasksUpdateDirect path)
 *
 * Side effects on success:
 *   - Updates `project` + `company` on the row
 *   - Optionally updates `campaign`
 *   - Backfills the Drive folder hierarchy (skipped at create time for
 *     personal notes; created here using the new project's company tree)
 *
 * Body: `{ id: string; project: string; campaign?: string }`
 */
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }

  let body: { id?: string; project?: string; campaign?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const taskId = String(body.id || "").trim();
  const newProject = String(body.project || "").trim();
  const newCampaign = String(body.campaign || "").trim();

  if (!taskId) {
    return NextResponse.json(
      { ok: false, error: "id is required" },
      { status: 400 },
    );
  }
  if (!newProject) {
    return NextResponse.json(
      { ok: false, error: "project is required" },
      { status: 400 },
    );
  }
  if (newProject.startsWith("__")) {
    return NextResponse.json(
      { ok: false, error: "Cannot promote into another pseudo-project" },
      { status: 400 },
    );
  }

  if (!useSATasksWrites()) {
    return NextResponse.json(
      { ok: false, error: "Promote requires the direct-SA write path" },
      { status: 503 },
    );
  }

  try {
    const { tasksGetDirect } = await import("@/lib/tasksDirect");
    const { tasksUpdateDirect } = await import("@/lib/tasksWriteDirect");

    // Fetch the existing row + verify it's a personal-note row owned by
    // the caller. Both checks must pass — the read gate already excludes
    // strangers from seeing personal notes, but the author-check here is
    // the explicit guard against a collaborator accidentally promoting
    // someone else's note.
    const existing = await tasksGetDirect(session.user.email, taskId).catch(
      () => null,
    );
    if (!existing?.task) {
      return NextResponse.json(
        { ok: false, error: "Task not found" },
        { status: 404 },
      );
    }
    const t = existing.task;
    if (!t.project.startsWith("__")) {
      return NextResponse.json(
        { ok: false, error: "Only personal notes can be promoted" },
        { status: 400 },
      );
    }
    const me = session.user.email.toLowerCase();
    if ((t.author_email || "").toLowerCase() !== me) {
      return NextResponse.json(
        { ok: false, error: "Only the author can promote a personal note" },
        { status: 403 },
      );
    }

    // Resolve company from Keys (will throw if the user has no access to
    // newProject, since the helper short-circuits on missing scope below).
    const { resolveCompany, isPseudoProject } = await import(
      "@/lib/tasksWriteDirect"
    );
    if (isPseudoProject(newProject)) {
      return NextResponse.json(
        { ok: false, error: "Cannot promote into another pseudo-project" },
        { status: 400 },
      );
    }
    const newCompany = await resolveCompany(session.user.email, newProject);

    // Backfill Drive folder under the real project's hierarchy. Done in
    // its own try so a Drive failure doesn't block the promote — task
    // metadata still flips, user can re-pick a folder via the edit panel
    // if Drive is flaky.
    let backfilledFolderId = t.drive_folder_id || "";
    let backfilledFolderUrl = t.drive_folder_url || "";
    if (!backfilledFolderId) {
      try {
        const { createTaskFolder } = await import("@/lib/tasksWriteDirect");
        const folder = await createTaskFolder({
          id: t.id,
          title: t.title,
          company: newCompany,
          project: newProject,
          campaign: newCampaign,
        });
        if (folder) {
          backfilledFolderId = folder.folderId;
          backfilledFolderUrl = folder.folderUrl;
        }
      } catch (e) {
        console.warn("[promote-personal] Drive backfill failed:", e);
      }
    }

    // Apply the promotion via the standard update path. We thread through
    // both project and company; campaign is optional. Drive folder fields
    // get persisted via a follow-up patch since the simple-direct update
    // path doesn't write drive_folder_url itself when only the URL changed
    // (it expects drive_folder_id which triggers the existing re-point
    // logic in tasksUpdateDirect to fetch + write the URL).
    const patch: Record<string, unknown> = {
      project: newProject,
      company: newCompany,
    };
    if (newCampaign) patch.campaign = newCampaign;
    if (backfilledFolderId && backfilledFolderId !== t.drive_folder_id) {
      patch.drive_folder_id = backfilledFolderId;
    }

    const result = await tasksUpdateDirect(session.user.email, taskId, patch);
    return NextResponse.json({
      ok: true,
      task: result.task,
      promotedTo: { project: newProject, company: newCompany },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
