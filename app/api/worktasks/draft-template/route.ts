import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getTaskFormSchema } from "@/lib/taskFormSchema";
import { resolveTemplate } from "@/lib/taskTemplates";
import { materializeDraft } from "@/lib/draftFolders";

/**
 * POST /api/worktasks/draft-template
 *
 * Materializes a per-user draft folder under `_drafts_/<userEmail>/`
 * and copies the template doc bound to (department, kind) into it.
 *
 * Called from /tasks/new whenever the issuer picks a (dept, kind)
 * pair that has a configured template (either explicit via the
 * TaskFormSchema sheet's "תבנית" column, or by folder convention via
 * `<shared>/סכמות משימה/<dept>/<kind>`).
 *
 * Returns `{ noTemplate: true }` when no template exists for the
 * pair — in that case the caller renders the form normally.
 *
 * Feature-flagged behind `ENABLE_TASK_TEMPLATES`. When the flag is
 * off the endpoint returns `{ noTemplate: true }` regardless of
 * schema state, so we can ship the route ahead of the form-side
 * wiring without users seeing half-built UI.
 *
 * Body: `{ department: string; kind: string; contextLabel?: string }`
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DraftTemplateRequest = {
  department?: string;
  kind?: string;
  contextLabel?: string;
};

export async function POST(req: Request) {
  if (process.env.ENABLE_TASK_TEMPLATES !== "1") {
    return NextResponse.json({ ok: true, noTemplate: true });
  }

  const session = await auth();
  const userEmail = session?.user?.email || "";
  if (!userEmail) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }

  let body: DraftTemplateRequest;
  try {
    body = (await req.json()) as DraftTemplateRequest;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }
  const department = String(body.department || "").trim();
  const kind = String(body.kind || "").trim();
  if (!department || !kind) {
    return NextResponse.json(
      { ok: false, error: "department and kind are required" },
      { status: 400 },
    );
  }

  // Resolve the template ref. Schema fetch can fail (sheet missing,
  // permission glitch, etc.) — pass null to the resolver in that case
  // so the folder-convention path still runs.
  const schema = await getTaskFormSchema(userEmail).catch(() => null);
  const tpl = await resolveTemplate(userEmail, department, kind, schema);
  if (!tpl) {
    return NextResponse.json({ ok: true, noTemplate: true });
  }

  try {
    const draft = await materializeDraft({
      subjectEmail: userEmail,
      userEmail,
      templateDocId: tpl.docId,
      templateName: tpl.docName,
      contextLabel: String(body.contextLabel || `${department} / ${kind}`),
    });
    return NextResponse.json({
      ok: true,
      noTemplate: false,
      ...draft,
      template: { docId: tpl.docId, source: tpl.source },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[/api/worktasks/draft-template] materialize failed:", msg);
    // Form falls back to no-template flow on a 500 here.
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
