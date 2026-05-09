import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getTaskFormSchema } from "@/lib/taskFormSchema";
import { resolveTemplate } from "@/lib/taskTemplates";
import { materializeDraft } from "@/lib/draftFolders";

/**
 * POST /api/worktasks/draft-template
 *
 * Materializes a per-user draft folder under `_drafts_/<userEmail>/`
 * and copies a chosen template file into it.
 *
 * The new-task form calls /api/worktasks/template-options first to
 * get the picker list, then POSTs here with the file the issuer
 * selected. The selected file gets copied (preserving mime type +
 * formatting) into a freshly-created draft folder so the issuer can
 * fill it inline before submitting. On task submit, the draft folder
 * is re-parented into the task's permanent Drive folder.
 *
 * Feature-flagged behind `ENABLE_TASK_TEMPLATES`. When the flag is
 * off the endpoint returns `{ noTemplate: true }` regardless of
 * input, so the form-side picker never gets a draft.
 *
 * Body: `{ department, kind, templateFileId, contextLabel? }`.
 *   - templateFileId: the file the issuer picked from the template-
 *     options response. Must live inside the resolved kind folder
 *     (server validates to prevent abuse — a hostile request can't
 *     point at an arbitrary Drive file).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DraftTemplateRequest = {
  department?: string;
  kind?: string;
  templateFileId?: string;
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
  const templateFileId = String(body.templateFileId || "").trim();
  if (!department || !kind || !templateFileId) {
    return NextResponse.json(
      {
        ok: false,
        error: "department, kind, and templateFileId are required",
      },
      { status: 400 },
    );
  }

  // Resolve the kind folder so we can validate the picked file is
  // actually one of its children. Without this guard, a hostile
  // request could ask us to copy any file the SA can read.
  const schema = await getTaskFormSchema(userEmail).catch(() => null);
  const tpl = await resolveTemplate(userEmail, department, kind, schema);
  if (!tpl) {
    return NextResponse.json({ ok: true, noTemplate: true });
  }
  const picked = tpl.files.find((f) => f.id === templateFileId);
  if (!picked) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "templateFileId is not in the resolved kind folder for this (department, kind)",
      },
      { status: 400 },
    );
  }

  try {
    const draft = await materializeDraft({
      subjectEmail: userEmail,
      userEmail,
      templateDocId: picked.id,
      templateName: picked.name,
      contextLabel: String(body.contextLabel || `${department} / ${kind}`),
    });
    return NextResponse.json({
      ok: true,
      noTemplate: false,
      ...draft,
      template: {
        docId: picked.id,
        docName: picked.name,
        source: tpl.source,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[/api/worktasks/draft-template] materialize failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
