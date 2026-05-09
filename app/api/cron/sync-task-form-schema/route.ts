import { NextResponse } from "next/server";
import { reconcileSchemaWithDrive } from "@/lib/syncTaskFormSchema";
import { driveFolderOwner } from "@/lib/sa";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cron entry point — reconciles the TaskFormSchema sheet with the
 * Drive `סכמות משימה/<Dept>/<File>` tree. Same shared-secret auth
 * pattern as /api/cron/poll-tasks.
 *
 * Drive → Sheet merge:
 *   - Drive files matched by id keep their sheet row up to date
 *     (rename in Drive → kind label updates in the sheet).
 *   - Drive files matched by (dept, kind) name fill in the
 *     templateDocId column on the existing row.
 *   - Drive files with no match create a new sheet row.
 *   - Sheet rows with no Drive match are preserved verbatim.
 *
 * Idempotent: re-running back to back finds nothing further to do.
 */

export async function POST(req: Request) {
  const expected = process.env.APPS_SCRIPT_API_TOKEN || "";
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "Server missing APPS_SCRIPT_API_TOKEN" },
      { status: 500 },
    );
  }
  const got =
    req.headers.get("x-cron-token") ||
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    "";
  if (got !== expected) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  try {
    const owner = driveFolderOwner() || "";
    if (!owner) {
      return NextResponse.json(
        { ok: false, error: "DRIVE_FOLDER_OWNER not configured" },
        { status: 500 },
      );
    }
    const result = await reconcileSchemaWithDrive(owner);
    console.log(
      "[cron/sync-task-form-schema] result:",
      JSON.stringify(result),
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[cron/sync-task-form-schema] error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

// Allow GET so manual smoke-tests don't need `-X POST`. Same auth.
export async function GET(req: Request) {
  return POST(req);
}
