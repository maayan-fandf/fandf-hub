import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { sheetsClient } from "@/lib/sa";
import { getAccessScope } from "@/lib/tasksDirect";
import {
  findCampaignFolderByName,
  renameCampaignFolder,
} from "@/lib/driveCampaigns";

export const dynamic = "force-dynamic";

function envOrThrow(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
}

function columnLetter(colNumber: number): string {
  let n = colNumber;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * POST /api/campaigns/rename
 * Body: { project: string, fromName: string, toName: string, folderId?: string }
 *
 * Renames a campaign in two coordinated writes:
 *   1. Drive folder `<company>/<project>/<fromName>` → `<toName>`.
 *   2. Bulk-update every task row in Comments (row_kind=task,
 *      project=P, campaign=fromName) to set campaign=toName.
 *
 * Caller can optionally pass `folderId` to skip the folder lookup —
 * useful when the picker already had it. Otherwise we resolve by name.
 *
 * Failures are NOT atomic (Drive + Sheets are separate APIs). The
 * order is: rename Drive first, then update Sheets. If Drive succeeds
 * and Sheets fails, the next read will show the new folder name in the
 * picker (Drive is canonical) but legacy task rows with the old name
 * become orphans surfacing as a duplicate entry. Operator runs the
 * rename again on the orphan to converge.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }
  const userEmail = session.user.email;

  let body: {
    project?: unknown;
    fromName?: unknown;
    toName?: unknown;
    folderId?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }
  const project = String(body.project || "").trim();
  const fromName = String(body.fromName || "").trim();
  const toName = String(body.toName || "").trim();
  const folderIdHint = String(body.folderId || "").trim();
  if (!project || !fromName || !toName) {
    return NextResponse.json(
      { ok: false, error: "project, fromName, toName are required" },
      { status: 400 },
    );
  }
  if (fromName === toName) {
    return NextResponse.json(
      { ok: false, error: "fromName and toName are identical" },
      { status: 400 },
    );
  }

  try {
    const scope = await getAccessScope(userEmail);
    if (!scope.isAdmin && !scope.accessibleProjects.has(project)) {
      return NextResponse.json(
        { ok: false, error: "Access denied to project: " + project },
        { status: 403 },
      );
    }
    const company = scope.projectCompany.get(project) || "";

    // Resolve the source folder. If the caller didn't pass `folderId`,
    // look it up by name. A missing folder is not fatal — it just means
    // the campaign is a task-only orphan; we still rename the task rows.
    let folderId = folderIdHint;
    if (!folderId) {
      const found = await findCampaignFolderByName(userEmail, {
        company,
        project,
        name: fromName,
      });
      folderId = found?.folderId || "";
    }

    // 1. Drive rename (best-effort if folder doesn't exist)
    let renamedFolder: { id: string; name: string; viewUrl: string } | null = null;
    if (folderId) {
      try {
        const r = await renameCampaignFolder(userEmail, {
          folderId,
          newName: toName,
        });
        renamedFolder = { id: r.id, name: r.name, viewUrl: r.viewUrl };
      } catch (e) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "Drive rename failed: " +
              (e instanceof Error ? e.message : String(e)),
          },
          { status: 500 },
        );
      }
    }

    // 2. Bulk-update task rows
    const sheets = sheetsClient(userEmail);
    const commentsSsId = envOrThrow("SHEET_ID_COMMENTS");
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: commentsSsId,
      range: "Comments",
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    });
    const values = (res.data.values ?? []) as unknown[][];
    let taskCount = 0;
    if (values.length >= 2) {
      const headers = (values[0] as unknown[]).map((h) =>
        String(h ?? "").trim(),
      );
      const idx = new Map<string, number>();
      headers.forEach((h, i) => {
        if (h) idx.set(h, i);
      });
      const rowKindIdx = idx.get("row_kind");
      const projIdx = idx.get("project");
      const campaignIdx = idx.get("campaign");
      if (rowKindIdx != null && projIdx != null && campaignIdx != null) {
        const data: { range: string; values: string[][] }[] = [];
        const colA1 = columnLetter(campaignIdx + 1);
        for (let i = 1; i < values.length; i++) {
          const row = values[i];
          if (String(row[rowKindIdx] ?? "").trim() !== "task") continue;
          if (String(row[projIdx] ?? "").trim() !== project) continue;
          if (String(row[campaignIdx] ?? "").trim() !== fromName) continue;
          // Sheet row number is i+1 (header at row 1).
          data.push({
            range: `Comments!${colA1}${i + 1}`,
            values: [[toName]],
          });
        }
        if (data.length > 0) {
          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: commentsSsId,
            requestBody: { valueInputOption: "RAW", data },
          });
          taskCount = data.length;
        }
      }
    }

    return NextResponse.json({
      ok: true,
      taskCount,
      folder: renamedFolder,
      project,
      fromName,
      toName,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
