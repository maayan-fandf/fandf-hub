import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { tasksCreate, type TasksCreateInput } from "@/lib/appsScript";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }

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

  try {
    const result = await tasksCreate(body);
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
