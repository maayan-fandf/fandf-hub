import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { projectSpaceCreate } from "@/lib/appsScript";

export const dynamic = "force-dynamic";

type Body = { project: string };

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  if (!body.project) {
    return NextResponse.json(
      { ok: false, error: "project is required" },
      { status: 400 },
    );
  }

  try {
    const result = await projectSpaceCreate(body.project);
    // The Apps Script action returns `{ok: false, error, howToFix}` when
    // the Chat API isn't enabled — pass that straight through so the
    // admin UI can render the help text.
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
