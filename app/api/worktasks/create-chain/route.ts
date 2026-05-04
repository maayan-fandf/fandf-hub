import { NextResponse } from "next/server";
import { auth } from "@/auth";
import type { TasksCreateChainInput } from "@/lib/tasksCreateChain";

export const dynamic = "force-dynamic";

/**
 * Chain creation endpoint — creates 1 umbrella container + N
 * sequential child tasks linked by blocks/blocked_by edges.
 *
 * Phase 5 of dependencies feature, 2026-05-03. See
 * lib/tasksCreateChain.ts for the orchestration details and
 * memory/project_dependencies_chains_pending.md for the design.
 *
 * Body shape:
 *   {
 *     project: string,
 *     company?: string,
 *     brief?: string,
 *     campaign?: string,
 *     departments?: string[],
 *     umbrella: { title: string, description?: string },
 *     steps: [{ title, assignees?, approver_email?, requested_date?, ... }]
 *   }
 *
 * Returns `{ ok: true, umbrella, children }` with full WorkTask
 * objects for each created row, or `{ ok: false, error }` on failure.
 *
 * NOTE: chain creation goes through the direct-SA path unconditionally
 * (the Apps Script proxy doesn't have a chain-creation handler). If
 * the SA write path is unhealthy, callers should fall back to creating
 * tasks individually via /api/worktasks/create + manually wiring deps.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }

  let body: TasksCreateChainInput;
  try {
    body = (await req.json()) as TasksCreateChainInput;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  // Surface schema mistakes early with helpful errors instead of
  // letting them bubble from the orchestrator's defensive throws.
  if (!body.project) {
    return NextResponse.json(
      { ok: false, error: "project is required" },
      { status: 400 },
    );
  }
  // umbrella.title is only required in the default umbrella mode;
  // flat-linked mode (withUmbrella=false) skips the umbrella entirely.
  if (body.withUmbrella !== false && !body.umbrella?.title) {
    return NextResponse.json(
      { ok: false, error: "umbrella.title is required when withUmbrella" },
      { status: 400 },
    );
  }
  if (!Array.isArray(body.steps) || body.steps.length === 0) {
    return NextResponse.json(
      { ok: false, error: "at least one step is required" },
      { status: 400 },
    );
  }

  try {
    const { tasksCreateChainDirect } = await import("@/lib/tasksCreateChain");
    const result = await tasksCreateChainDirect(session.user.email, body);
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[/api/worktasks/create-chain] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
