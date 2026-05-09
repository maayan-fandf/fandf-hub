import { NextResponse } from "next/server";
import { reapOldDraftFolders } from "@/lib/draftFolders";
import { driveFolderOwner } from "@/lib/sa";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cron entry point — daily GC for orphan task-template drafts.
 *
 * The /tasks/new inline-template feature creates per-user draft
 * folders under `_drafts_/<userEmail>/` whenever an issuer picks a
 * (department, kind) with a configured template. Most drafts get
 * either committed (re-parented into the campaign hierarchy on task
 * submit) or cancelled (POST /api/worktasks/draft-cancel on (dept,
 * kind) change or beforeunload). The leftover are abandoned drafts
 * — tab closed without sendBeacon completing, server error during
 * cancel, etc. This job sweeps everything older than 24 hours.
 *
 * Auth: same `APPS_SCRIPT_API_TOKEN` shared-secret pattern as
 * /api/cron/poll-tasks. Cloud Scheduler attaches it as either a
 * `X-Cron-Token` header or `Authorization: Bearer <token>`.
 *
 * Idempotent — re-firing back to back is safe; the second run finds
 * no further candidates.
 */

const DEFAULT_TTL_HOURS = 24;

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

  // Allow the cutoff to be overridden via ?ttl_hours=NN for manual
  // smoke-tests + ad-hoc cleanup. Defaults to 24h when absent.
  let ttlHours = DEFAULT_TTL_HOURS;
  try {
    const url = new URL(req.url);
    const raw = Number(url.searchParams.get("ttl_hours"));
    if (Number.isFinite(raw) && raw > 0 && raw < 24 * 30) {
      ttlHours = raw;
    }
  } catch {
    /* keep default */
  }

  try {
    const owner = driveFolderOwner() || "";
    if (!owner) {
      return NextResponse.json(
        { ok: false, error: "DRIVE_FOLDER_OWNER not configured" },
        { status: 500 },
      );
    }
    const result = await reapOldDraftFolders({
      subjectEmail: owner,
      olderThanMs: ttlHours * 60 * 60 * 1000,
    });
    console.log(
      "[cron/cleanup-task-drafts] result:",
      JSON.stringify({ ttlHours, ...result }),
    );
    return NextResponse.json({ ok: true, ttlHours, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[cron/cleanup-task-drafts] error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

// Allow GET so manual smoke-tests from a browser / curl don't need
// `-X POST`. Same auth.
export async function GET(req: Request) {
  return POST(req);
}
