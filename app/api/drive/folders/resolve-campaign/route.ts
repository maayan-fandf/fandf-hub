import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { findCampaignFolderId } from "@/lib/driveFolders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  company?: string;
  project?: string;
  campaign?: string;
};

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
  const project = String(body.project || "").trim();
  if (!project) {
    return NextResponse.json(
      { ok: false, error: "project is required" },
      { status: 400 },
    );
  }
  try {
    // READ-ONLY. Returns { folderId: null } when any path segment is
    // missing — do NOT auto-create here. The task-create orchestrator
    // calls `ensureCampaignFolderId` later (at save time).
    const result = await findCampaignFolderId(session.user.email, {
      company: String(body.company || "").trim(),
      project,
      campaign: String(body.campaign || "").trim(),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
