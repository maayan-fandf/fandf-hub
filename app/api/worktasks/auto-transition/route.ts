import { NextResponse } from "next/server";
import { applyAutoTransition } from "@/lib/autoTransition";
import type { GTaskKind } from "@/lib/appsScript";

export const dynamic = "force-dynamic";

/**
 * POST /api/worktasks/auto-transition
 *
 * Server-to-server endpoint called by the Apps Script poller
 * (`pollTaskCompletions`) when it detects a Google Task has been
 * marked complete. The poller passes the completed entry's `kind` and
 * the user who marked it; this endpoint applies the right hub
 * transition, which in turn triggers all the side effects already
 * wired in `tasksUpdateDirect` (close other GTs, spawn the next-stage
 * GT, write history, post Chat / send notifications).
 *
 * Centralizing the transition logic here keeps Apps Script as a thin
 * "detect + dispatch" layer — no need to mirror the kind-aware spawn
 * logic on the Apps Script side.
 *
 * Auth: shared `APPS_SCRIPT_API_TOKEN` matched against the body's
 * `token`. NextAuth session is NOT required because Apps Script
 * triggers run unattended.
 */
export async function POST(req: Request) {
  let body: {
    token?: unknown;
    taskId?: unknown;
    kind?: unknown;
    completedBy?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }
  const expected = process.env.APPS_SCRIPT_API_TOKEN || "";
  if (!expected || String(body.token || "") !== expected) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }
  const taskId = String(body.taskId || "").trim();
  const kind = String(body.kind || "todo") as GTaskKind;
  const completedBy = String(body.completedBy || "").trim().toLowerCase();
  if (!taskId) {
    return NextResponse.json(
      { ok: false, error: "taskId is required" },
      { status: 400 },
    );
  }
  if (kind !== "todo" && kind !== "approve" && kind !== "clarify") {
    return NextResponse.json(
      { ok: false, error: "kind must be todo / approve / clarify" },
      { status: 400 },
    );
  }

  const result = await applyAutoTransition({ taskId, kind, completedBy });
  if ("error" in result) {
    return NextResponse.json(result, { status: 500 });
  }
  return NextResponse.json(result);
}
