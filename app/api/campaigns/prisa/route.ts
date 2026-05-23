import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { canSeeCampaigns } from "@/lib/userRole";
import {
  pickLatestPrisotForCompanyOrProject,
  readPrisotData,
} from "@/lib/driveFolders";

export const dynamic = "force-dynamic";

/**
 * GET /api/campaigns/prisa?company=<he>&project=<he>
 *
 * Lazily resolves the latest פריסה (approved media-plan spread) for a
 * project — the same Drive lookup the project page's LatestPrisotCard
 * does (project's פריסות folder, falling back to the company's כללי).
 * Used by the budget desk's "פריסה מאושרת" popup so managers can
 * eyeball the approved allocation against the live distribution without
 * leaving the desk. Fetched per project on click (Drive lookup is
 * ~0.5–2s) rather than eagerly for every project.
 */
export async function GET(req: Request) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }
  const allowed = await canSeeCampaigns(email).catch(() => false);
  if (!allowed) {
    return NextResponse.json(
      { ok: false, error: "Not authorized" },
      { status: 403 },
    );
  }

  const url = new URL(req.url);
  const company = (url.searchParams.get("company") || "").trim();
  const project = (url.searchParams.get("project") || "").trim();
  if (!company) {
    return NextResponse.json(
      { ok: false, error: "company is required" },
      { status: 400 },
    );
  }

  try {
    const latest = await pickLatestPrisotForCompanyOrProject(
      email,
      company,
      project,
    ).catch(() => null);
    if (!latest) {
      return NextResponse.json({ ok: true, prisa: null });
    }

    const isImage = latest.mimeType.startsWith("image/");
    const isSheet =
      latest.mimeType === "application/vnd.google-apps.spreadsheet";
    const data = isSheet
      ? await readPrisotData(email, latest.id).catch(() => null)
      : null;

    return NextResponse.json({
      ok: true,
      prisa: {
        id: latest.id,
        name: latest.name,
        mimeType: latest.mimeType,
        webViewLink: latest.webViewLink,
        folderUrl: latest.folderUrl,
        modifiedTime: latest.modifiedTime,
        approvalState: latest.approvalState,
        source: latest.source,
        isImage,
        isSheet,
        data,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
