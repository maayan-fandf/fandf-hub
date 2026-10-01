import { NextResponse } from "next/server";
import { requireTeam } from "@/lib/viewerGate";
import { findCampaignFolderId } from "@/lib/driveFolders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  company?: string;
  project?: string;
  campaign?: string;
};

export async function POST(req: Request) {
  // Team only: this turns any company / project / campaign NAME into its
  // Drive folder id, looked up as the Shared Drive owner — the first step
  // of walking someone else's folders. Both callers are in the task form,
  // which clients never reach.
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
    const result = await findCampaignFolderId(gate.email, {
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
