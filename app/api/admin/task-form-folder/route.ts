import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getMyProjects, currentUserEmail } from "@/lib/appsScript";
import {
  ensureDeptFolder,
  ensureKindFolder,
} from "@/lib/taskTemplates";
import { invalidateTaskFormSchema } from "@/lib/taskFormSchema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/task-form-folder
 *
 * Backs the "+ הוסף מחלקה" / "+ הוסף סוג" buttons on
 * /admin/task-form-schema. Creates the requested folder under
 * `<shared>/סכמות משימה/` directly in Drive — there's no parallel
 * sheet to keep in sync because the schema reads straight from Drive.
 *
 * Idempotent: a folder with the same name returns its existing id
 * without creating a duplicate.
 *
 * Body: `{ dept: string; kind?: string }`
 *   - dept only → create dept folder
 *   - dept + kind → create kind folder under dept (dept folder is
 *     en-route created if missing)
 *
 * Admin-only.
 */

type Request = {
  dept?: string;
  kind?: string;
};

async function gateAdmin(): Promise<{ adminEmail: string } | NextResponse> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }
  const me = await getMyProjects().catch(() => null);
  if (!me?.isAdmin) {
    return NextResponse.json(
      { ok: false, error: "Admin only" },
      { status: 403 },
    );
  }
  return { adminEmail: email };
}

export async function POST(req: globalThis.Request) {
  const gate = await gateAdmin();
  if (gate instanceof NextResponse) return gate;

  let body: Request;
  try {
    body = (await req.json()) as Request;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }
  const dept = String(body.dept || "").trim();
  const kind = String(body.kind || "").trim();
  if (!dept) {
    return NextResponse.json(
      { ok: false, error: "dept is required" },
      { status: 400 },
    );
  }

  try {
    const subject = (await currentUserEmail()) || gate.adminEmail;
    let folderId: string;
    if (kind) {
      folderId = await ensureKindFolder(subject, dept, kind);
    } else {
      folderId = await ensureDeptFolder(subject, dept);
    }
    invalidateTaskFormSchema();
    return NextResponse.json({
      ok: true,
      folderId,
      kind: kind || null,
      dept,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[/api/admin/task-form-folder] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
