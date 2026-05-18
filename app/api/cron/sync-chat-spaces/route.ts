import { NextResponse } from "next/server";
import { reconcileAllChatSpaces } from "@/lib/chatSpaceSync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cron entry point — reconciles every project's internal Chat space
 * membership to exactly its Keys roster (cols C/D/J/K, @fandf-only,
 * roster-ONLY). Intended to be hit by Cloud Scheduler.
 *
 * Auth model: identical to /api/cron/poll-tasks — the shared-secret
 * APPS_SCRIPT_API_TOKEN sent as `X-Cron-Token` (or Bearer).
 *
 * Idempotent + self-gating: reconcileAllChatSpaces() is a no-op unless
 * USE_RESTRICTED_CHAT_SPACES=1 (so this route is safe to deploy +
 * schedule before the flag is flipped), drops re-entrant calls, and
 * has hard mass-removal safety rails (see lib/chatSpaceSync.ts).
 *
 * Cloud Scheduler setup (owner — no gcloud in the Claude env; see
 * memory/feedback_gcloud_scheduler_gotchas.md): create a job POSTing
 * to https://hub.fandf.co.il/api/cron/sync-chat-spaces with header
 * X-Cron-Token=<APPS_SCRIPT_API_TOKEN>, a non-empty body ("{}"), at a
 * modest cadence (e.g. every 15–30 min — roster churn is rare; this
 * does not need minute-level freshness).
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
    const result = await reconcileAllChatSpaces();
    console.log("[cron/sync-chat-spaces] result:", JSON.stringify(result));
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[cron/sync-chat-spaces] error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

// Allow GET for manual smoke-tests (same auth).
export async function GET(req: Request) {
  return POST(req);
}
