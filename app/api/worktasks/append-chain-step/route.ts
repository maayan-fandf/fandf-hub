import { NextResponse } from "next/server";
import { auth } from "@/auth";
import type { AppendChainStepInput } from "@/lib/appendChainStep";

export const dynamic = "force-dynamic";

/**
 * Append a step to the end of an existing chain. Phase 9 of
 * dependencies feature, 2026-05-03. See lib/appendChainStep.ts
 * for orchestration details.
 *
 * Body: { umbrellaId, title, assignees?, ... }
 * Returns: { ok: true, step, appendedAfter } | { ok: false, error }
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ ok: false, error: "Not authenticated" }, { status: 401 });
  }

  let body: AppendChainStepInput;
  try {
    body = (await req.json()) as AppendChainStepInput;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.umbrellaId) {
    return NextResponse.json({ ok: false, error: "umbrellaId is required" }, { status: 400 });
  }
  if (!body.title?.trim()) {
    return NextResponse.json({ ok: false, error: "title is required" }, { status: 400 });
  }

  try {
    const { appendChainStepDirect } = await import("@/lib/appendChainStep");
    const result = await appendChainStepDirect(session.user.email, body);
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[/api/worktasks/append-chain-step] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
