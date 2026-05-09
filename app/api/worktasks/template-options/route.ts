import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getTaskFormSchema } from "@/lib/taskFormSchema";
import { resolveTemplate } from "@/lib/taskTemplates";

/**
 * GET /api/worktasks/template-options?department=&kind=
 *
 * Returns the list of template files that live in the kind folder
 * for `(department, kind)`. The new-task form calls this whenever
 * the issuer picks a new kind, so the form can show a picker letting
 * them choose which template to copy into their task. Empty list
 * means "no picker" — either the kind folder doesn't exist yet, or
 * the admin hasn't dropped any templates in it.
 *
 * Returns `{ noTemplate: true }` when the (dept, kind) has no
 * template binding at all (no folder, no schema override).
 *
 * Feature-flagged behind `ENABLE_TASK_TEMPLATES`. With the flag off,
 * always returns `{ noTemplate: true }` so the form-side picker
 * never renders during rollout.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
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

  const url = new URL(req.url);
  const department = String(url.searchParams.get("department") || "").trim();
  const kind = String(url.searchParams.get("kind") || "").trim();
  if (!department || !kind) {
    return NextResponse.json(
      { ok: false, error: "department and kind are required" },
      { status: 400 },
    );
  }

  const schema = await getTaskFormSchema(userEmail).catch(() => null);
  const tpl = await resolveTemplate(userEmail, department, kind, schema);
  if (!tpl) {
    return NextResponse.json({ ok: true, noTemplate: true });
  }

  return NextResponse.json({
    ok: true,
    noTemplate: false,
    folderId: tpl.folderId,
    folderName: tpl.folderName,
    files: tpl.files,
    source: tpl.source,
  });
}
