import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { driveClient, driveFolderOwner } from "@/lib/sa";
import {
  pickLatestPrisotForCompanyOrProject,
} from "@/lib/driveFolders";
import { HUB_ADMIN_EMAILS } from "@/lib/tasksDirect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin-only diagnostic endpoint for the Drive Approvals API. Hits the
 * raw `GET /drive/v3/files/{fileId}/approvals` for the latest פריסה
 * file resolved from (company, project) and returns the verbatim
 * response so we can see what Google actually says about a file's
 * approval state.
 *
 * Usage:
 *   /api/admin/debug/drive-approvals?company=גיא ודורון&project=כללי
 *   /api/admin/debug/drive-approvals?fileId=<id>          (skip the
 *                                                           prisot
 *                                                           lookup)
 *
 * Returns:
 *   {
 *     ok: true,
 *     impersonatedAs: "<email>",
 *     fileId: "<id>",
 *     fileName: "<name>",
 *     approvalsApi: {
 *       url: "...",
 *       status: <http status>,
 *       body: <raw JSON or text>,
 *     },
 *     parsedState: "approved" | "pending" | "none"
 *   }
 *
 * Built specifically to diagnose the "I see Pending in Drive UI but
 * the hub says לא מאושר" report — the API response's exact shape
 * (items[] vs approvals[], approvalId vs id, status enum values)
 * tells us what to fix.
 */
export async function GET(req: Request) {
  const session = await auth();
  const email = (session?.user?.email || "").toLowerCase().trim();
  if (!email) {
    return NextResponse.json(
      { ok: false, error: "unauthenticated" },
      { status: 401 },
    );
  }
  // Hub-admin gate — same set used elsewhere. Diagnostic info isn't
  // sensitive (it's just the user's own approvals on a file they can
  // already see), but no reason to expose it broadly.
  if (!HUB_ADMIN_EMAILS.has(email)) {
    return NextResponse.json(
      { ok: false, error: "forbidden" },
      { status: 403 },
    );
  }

  const url = new URL(req.url);
  const company = (url.searchParams.get("company") || "").trim();
  const project = (url.searchParams.get("project") || "").trim();
  const explicitFileId = (url.searchParams.get("fileId") || "").trim();

  let fileId = explicitFileId;
  let fileName = "";
  let folderUrl = "";
  if (!fileId) {
    if (!company || !project) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "supply ?fileId=<id> OR both ?company=<co>&project=<proj> to resolve the latest פריסה",
        },
        { status: 400 },
      );
    }
    const latest = await pickLatestPrisotForCompanyOrProject(
      email,
      company,
      project,
    ).catch((e) => ({ _err: e instanceof Error ? e.message : String(e) }));
    if (!latest || (latest as { _err?: string })._err) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "no פריסה found for (" +
            company +
            ", " +
            project +
            ")" +
            ((latest as { _err?: string })?._err
              ? ": " + (latest as { _err: string })._err
              : ""),
        },
        { status: 404 },
      );
    }
    fileId = (latest as { id: string }).id;
    fileName = (latest as { name: string }).name;
    folderUrl = (latest as { folderUrl?: string }).folderUrl || "";
  }

  // Pull the same impersonated-user token fetchApprovalState uses, so
  // the debug result mirrors the production resolution path.
  const impersonatedAs = driveFolderOwner() || email;
  const drive = driveClient(impersonatedAs);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const auth2 = (drive.context as any)._options?.auth as
    | { getAccessToken: () => Promise<{ token?: string | null }> }
    | undefined;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const tokenResp = await auth2?.getAccessToken?.();
  const token = tokenResp?.token || "";

  // No ?supportsAllDrives — the /approvals endpoint rejects it. See
  // matching note in lib/driveFolders.ts → fetchApprovalState.
  const apiUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
    fileId,
  )}/approvals`;
  let httpStatus = 0;
  let apiBody: unknown = null;
  try {
    const r = await fetch(apiUrl, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    httpStatus = r.status;
    const text = await r.text();
    try {
      apiBody = JSON.parse(text);
    } catch {
      apiBody = text;
    }
  } catch (e) {
    apiBody = e instanceof Error ? e.message : String(e);
  }

  // Mirror the parse logic from fetchApprovalState so we can see what
  // status the production resolver would have computed for this raw
  // response. Helps tell parse-bug from API-state-empty.
  let parsedState: "approved" | "pending" | "none" = "none";
  let parsedReason = "";
  /* eslint-disable @typescript-eslint/no-explicit-any */
  if (httpStatus >= 200 && httpStatus < 300 && apiBody && typeof apiBody === "object") {
    const list: any[] =
      ((apiBody as any).items as any[]) ||
      ((apiBody as any).approvals as any[]) ||
      [];
    if (list.length === 0) {
      parsedReason = "items[] empty";
    } else {
      const stamp = (a: any) =>
        a.createTime || a.modifyTime || a.requestTime || "";
      const sorted = [...list].sort((a, b) =>
        String(stamp(b)).localeCompare(String(stamp(a))),
      );
      const status = String(sorted[0]?.status || "").toUpperCase();
      parsedReason = `latest status=${status}`;
      if (status === "APPROVED") parsedState = "approved";
      else if (status === "IN_PROGRESS") parsedState = "pending";
      else parsedState = "none";
    }
  } else {
    parsedReason = `http ${httpStatus}`;
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return NextResponse.json({
    ok: true,
    impersonatedAs,
    fileId,
    fileName,
    folderUrl,
    approvalsApi: {
      url: apiUrl,
      status: httpStatus,
      body: apiBody,
    },
    parsedState,
    parsedReason,
  });
}
