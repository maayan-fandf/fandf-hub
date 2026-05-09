import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getMyProjects, currentUserEmail } from "@/lib/appsScript";
import { reconcileSchemaWithDrive } from "@/lib/syncTaskFormSchema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin endpoint — same Drive ↔ Sheet reconciliation as the daily
 * cron, triggered manually from the /admin/task-form-schema editor's
 * "🔄 סנכרן מ-Drive" button. Lets the admin pick up new files they
 * just dropped in Drive without waiting for the next cron tick.
 *
 * Same admin gate as /api/admin/task-form-schema.
 */

export async function POST() {
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

  try {
    // The reconciler reads + writes the schema sheet via the SA's
    // delegated session — the admin's email is just used so the
    // helper picks up the right impersonation subject. (Internally
    // it routes through driveFolderOwner() as the actual subject.)
    const adminEmail = (await currentUserEmail()) || email;
    const result = await reconcileSchemaWithDrive(adminEmail);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[/api/admin/sync-task-form-schema] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
