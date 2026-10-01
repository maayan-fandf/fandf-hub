import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { tasksCreate, type TasksCreateInput } from "@/lib/appsScript";
import { useSATasksWrites } from "@/lib/sa";
import { requireTeam } from "@/lib/viewerGate";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }
  // Team only: creating a task assigns staff, spawns their Google Tasks,
  // sends mail and writes a billing row. /tasks/new bounces clients.
  const gate = await requireTeam();
  if (gate instanceof NextResponse) return gate;

  let body: TasksCreateInput;
  try {
    body = (await req.json()) as TasksCreateInput;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  if (!body.project || !body.title) {
    return NextResponse.json(
      { ok: false, error: "project and title are required" },
      { status: 400 },
    );
  }
  // The id is the server's to mint. A pre-assigned one is for the chain
  // orchestrators, which call the lib directly — from the request it
  // would REPLACE an existing task's doc (the create is a set-by-id).
  delete body.id;

  try {
    // Fast path: direct Google API calls via the DWD service account.
    // Falls back to the Apps Script proxy when the flag is off, e.g.
    // during rollout or if the write path needs to be reverted.
    if (useSATasksWrites()) {
      const { tasksCreateDirect } = await import("@/lib/tasksWriteDirect");
      const result = await tasksCreateDirect(session.user.email, body);
      return NextResponse.json(result);
    }
    const result = await tasksCreate(body);
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
