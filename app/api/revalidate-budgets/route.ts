/**
 * Cache-bust webhook — restores the pre-migration "instant" feel for budget
 * edits. The Apps Script `onEdit` trigger on the main spreadsheet (SHEET_ID_MAIN)
 * POSTs here the moment a cell is edited; we drop just the budget-relevant
 * cross-request caches so the next Hub view re-reads the Sheet fresh. Keeps the
 * pages fast (the 5-min cache still absorbs normal traffic) while making edits
 * show up immediately — better than the old always-live-read behavior.
 *
 * Also called Hub-side after the budget desk's own writes (see the budget apply
 * route) so a Hub-originated edit reflects on itself without waiting for the TTL.
 *
 * Auth: the shared APPS_SCRIPT_API_TOKEN, as the `x-api-token` header, `?token=`,
 * or POST body.token — same gate as /api/alert-dismissals.
 */
import { NextResponse } from "next/server";
import { bustBudgetCaches } from "@/lib/revalidateBudgets";

export const dynamic = "force-dynamic";

function isAuthorized(req: Request, bodyToken?: unknown): boolean {
  const expected = process.env.APPS_SCRIPT_API_TOKEN || "";
  if (!expected) return false;
  if ((req.headers.get("x-api-token") || "") === expected) return true;
  if (typeof bodyToken === "string" && bodyToken === expected) return true;
  try {
    if (new URL(req.url).searchParams.get("token") === expected) return true;
  } catch {
    /* ignore malformed URL */
  }
  return false;
}

async function handle(req: Request, bodyToken?: unknown) {
  if (!isAuthorized(req, bodyToken)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  bustBudgetCaches();
  return NextResponse.json({ ok: true, revalidated: true });
}

export async function POST(req: Request) {
  let token: unknown;
  try {
    token = (await req.json())?.token;
  } catch {
    /* body optional — header/query auth still works */
  }
  return handle(req, token);
}

// GET convenience (same token gate) so the trigger — or a manual curl — can
// bust the cache with a plain request.
export async function GET(req: Request) {
  return handle(req);
}
