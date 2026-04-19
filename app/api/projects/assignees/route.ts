import { NextRequest, NextResponse } from "next/server";
import { getProjectAssignees } from "@/lib/appsScript";

export async function GET(req: NextRequest) {
  const project = req.nextUrl.searchParams.get("project");
  if (!project) {
    return NextResponse.json({ error: "project query param required" }, { status: 400 });
  }

  try {
    const result = await getProjectAssignees(project);
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
