import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { deleteDraftFolder } from "@/lib/draftFolders";

/**
 * POST /api/worktasks/draft-cancel
 *
 * Deletes a draft folder created by /api/worktasks/draft-template.
 * The deletion is path-checked server-side: only folders whose parent
 * folder name matches the session user's email AND whose grandparent
 * is the `_drafts_` folder are eligible. A request that names some
 * other folder id is rejected as a no-op.
 *
 * Called by /tasks/new when the user changes their (dept, kind)
 * selection (so a new template can be materialized) and as a
 * best-effort `navigator.sendBeacon` on `beforeunload`.
 *
 * Body: `{ draftFolderId: string }`
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DraftCancelRequest = {
  draftFolderId?: string;
};

export async function POST(req: Request) {
  const session = await auth();
  const userEmail = session?.user?.email || "";
  if (!userEmail) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }

  let body: DraftCancelRequest;
  try {
    body = (await req.json()) as DraftCancelRequest;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }
  const draftFolderId = String(body.draftFolderId || "").trim();
  if (!draftFolderId) {
    return NextResponse.json(
      { ok: false, error: "draftFolderId is required" },
      { status: 400 },
    );
  }

  const ok = await deleteDraftFolder({
    subjectEmail: userEmail,
    userEmail,
    draftFolderId,
  });
  return NextResponse.json({ ok: true, deleted: ok });
}
