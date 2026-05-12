import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getTaskComments } from "@/lib/appsScript";
import { listTaskAttachments } from "@/lib/taskUpload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/tasks/peek?id=<taskId>&folder=<driveFolderId>&title=<title>
 *
 * Lazy fetch for the task quick-preview drawer (TaskPreviewProvider).
 * Returns the discussion + attachments in one round-trip so the drawer
 * doesn't make two separate fetches when the user clicks 👁 on a row.
 *
 * `folder` and `title` are passed from the WorkTask the client already
 * has in memory — letting the server skip the Sheets read for the task
 * row itself. If `folder` is empty the files block is returned empty
 * (legacy tasks created before drive_folder_id was wired).
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
  const id = (url.searchParams.get("id") || "").trim();
  if (!id) {
    return NextResponse.json(
      { ok: false, error: "id required" },
      { status: 400 },
    );
  }
  const folder = (url.searchParams.get("folder") || "").trim();
  const title = (url.searchParams.get("title") || "").trim();

  try {
    const [taskComments, attachments] = await Promise.all([
      getTaskComments(id),
      folder
        ? listTaskAttachments(session.user.email, folder, id, title)
        : Promise.resolve({ folderId: "", folderUrl: "", files: [] }),
    ]);
    return NextResponse.json({
      ok: true,
      comments: taskComments.comments,
      files: attachments.files,
      folderUrl: attachments.folderUrl,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
