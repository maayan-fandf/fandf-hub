import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { HUB_ADMIN_EMAILS } from "@/lib/tasksDirect";
import { streamClaudeChat } from "@/lib/claudeChat";
import { TOOL_DECLARATIONS } from "@/lib/geminiTools";
import { SYSTEM_PERSONA } from "@/app/api/gemini/chat/route";
import { AI_EVAL_CASES } from "@/lib/aiEvalCases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One model turn per case, sequential — give it headroom.
export const maxDuration = 300;

/**
 * Tool-routing eval harness for the chat assistant. Admin-only.
 *
 * Replays AI_EVAL_CASES through the SAME persona + tool catalog the
 * live assistant uses, and checks the model's FIRST hub tool call
 * lands in the case's expected set. We break on the first toolCall
 * chunk (streamClaudeChat yields it before executing), so:
 *   - no tool actually runs → no Sheets/Gmail access, no mutations
 *   - cost is ~one model turn per case
 *   - we measure ROUTING only (the thing that regressed with the CRM
 *     funnel), not answer content.
 *
 * GET /api/admin/ai-eval            run all cases
 * GET /api/admin/ai-eval?id=<id>    run one case
 *
 * Returns JSON: { total, passed, failed, results[] }. Run it after any
 * tool/persona change and before shipping write tools (Phase 3).
 */
export async function GET(req: Request) {
  const session = await auth();
  const email = session?.user?.email?.toLowerCase().trim();
  if (!email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }
  if (!HUB_ADMIN_EMAILS.has(email)) {
    return NextResponse.json(
      { ok: false, error: "Admin only" },
      { status: 403 },
    );
  }

  const only = new URL(req.url).searchParams.get("id");
  const cases = only
    ? AI_EVAL_CASES.filter((c) => c.id === only)
    : AI_EVAL_CASES;
  if (cases.length === 0) {
    return NextResponse.json(
      { ok: false, error: `no eval case with id '${only}'` },
      { status: 404 },
    );
  }

  const results: {
    id: string;
    question: string;
    expectAnyOf: string[];
    firstTool: string;
    pass: boolean;
    error?: string;
  }[] = [];

  for (const c of cases) {
    let firstTool = "(none)";
    let error: string | undefined;
    try {
      for await (const chunk of streamClaudeChat({
        system: SYSTEM_PERSONA,
        history: [{ role: "user", text: c.question }],
        tools: TOOL_DECLARATIONS,
        // Never reached — we break on the first toolCall chunk, which
        // streamClaudeChat yields before invoking executeTool. Present
        // only to satisfy the signature defensively.
        executeTool: async () => ({
          ok: false as const,
          error: "eval: routing-only, tool not executed",
        }),
      })) {
        if ("toolCall" in chunk) {
          firstTool = chunk.toolCall.name;
          break; // routing captured — abandon the rest of the turn
        }
        // ignore text / searchQuery / final-summary chunks; if the
        // stream ends with no toolCall, firstTool stays "(none)".
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    results.push({
      id: c.id,
      question: c.question,
      expectAnyOf: c.expectAnyOf,
      firstTool,
      pass: !error && c.expectAnyOf.includes(firstTool),
      ...(error ? { error } : {}),
    });
  }

  const passed = results.filter((r) => r.pass).length;
  return NextResponse.json({
    ok: true,
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
  });
}
