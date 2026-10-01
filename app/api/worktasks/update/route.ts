import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { tasksUpdate, type TasksUpdatePatch } from "@/lib/appsScript";
import { useSATasksWrites } from "@/lib/sa";
import { requireTeam } from "@/lib/viewerGate";

export const dynamic = "force-dynamic";

type Body = { id: string; patch: TasksUpdatePatch };

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }
  // Team only: a client is in scope for their own project, so the lib's
  // project check alone would let them read (the response is the full
  // task row, price included) and re-status its tasks.
  const gate = await requireTeam();
  if (gate instanceof NextResponse) return gate;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  if (!body.id) {
    return NextResponse.json(
      { ok: false, error: "id is required" },
      { status: 400 },
    );
  }

  try {
    // Same flag-gated direct path as create.
    if (useSATasksWrites()) {
      const { tasksUpdateDirect } = await import("@/lib/tasksWriteDirect");
      const result = await tasksUpdateDirect(
        session.user.email,
        body.id,
        body.patch || {},
      );
      return NextResponse.json(result);
    }
    const result = await tasksUpdate(body.id, body.patch || {});
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
