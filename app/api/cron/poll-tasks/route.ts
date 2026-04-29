import { NextResponse } from "next/server";
import { pollAllTaskCompletions } from "@/lib/pollTasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cron entry point — replaces Apps Script's `pollTaskCompletions`
 * scheduled trigger. Hit by Cloud Scheduler every minute.
 *
 * Auth model:
 *   - Cloud Scheduler attaches an OIDC bearer token bound to a
 *     service account. We don't validate it here yet — instead we
 *     use the same shared-secret token Apps Script used to talk to
 *     /api/worktasks/auto-transition (env: APPS_SCRIPT_API_TOKEN).
 *     Cloud Scheduler is configured to send it as a header.
 *   - Manual invocations from a developer machine work the same way:
 *     `curl -H "X-Cron-Token: $TOKEN" .../api/cron/poll-tasks`.
 *
 * The endpoint is idempotent — re-firing within the same minute is
 * harmless because the poll function itself drops re-entrant calls
 * (in-process flag) and individual auto-transitions skip when the
 * task already moved past the relevant kind's stage.
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
    const result = await pollAllTaskCompletions();
    console.log("[cron/poll-tasks] result:", JSON.stringify(result));
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[cron/poll-tasks] error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

// Allow GET as well so manual smoke-tests from a browser / curl don't
// require -X POST. Same auth.
export async function GET(req: Request) {
  return POST(req);
}
