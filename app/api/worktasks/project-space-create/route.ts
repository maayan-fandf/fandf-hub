import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getMyProjects } from "@/lib/appsScript";
import { createChatSpaceForProject } from "@/lib/chatSpaceCreate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  project: string;
  /** Disambiguates non-unique project names (כללי has 4 rows). The
   *  CreateChatSpaceButton on /projects/<name>?company=<X> pages the
   *  current company through; without it, helper falls back to first-
   *  by-name which silently picks the wrong row. Optional for back-
   *  compat with the legacy /admin/chat-spaces flow. */
  company?: string;
};

/**
 * Create a Google Chat Space for a project + write the URL back into
 * the project's Keys row. Used by /admin/chat-spaces (and, eventually,
 * the per-row "Create Space" action in the Keys editor that retires
 * this standalone page).
 *
 * Hub-next-direct via SA + DWD — no longer routes through Apps Script.
 * Requires the `chat.spaces.create` scope on DWD client 102907403320696302169.
 */
export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }

  // Admin gate. Same shape `/admin/chat-spaces` server component uses.
  const me = await getMyProjects().catch(() => null);
  if (!me?.isAdmin) {
    return NextResponse.json(
      { ok: false, error: "Admin only" },
      { status: 403 },
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

  const result = await createChatSpaceForProject(
    email,
    body.project,
    body.company,
  );
  if (!result.ok) {
    // Pass `howToFix` through so the admin UI can render the targeted
    // hint when the failure is the missing DWD scope.
    return NextResponse.json(result, { status: 400 });
  }
  // Map to the response shape the existing ChatSpacesList client
  // already understands: { ok, space: { name, spaceUri, displayName } }.
  // Plus `invite` so the UI can surface partial-success info (members
  // added vs failed, scope-missing hint).
  return NextResponse.json({
    ok: true,
    space: {
      name: result.spaceName,
      spaceUri: result.spaceUri,
      displayName: result.project,
    },
    keysCellUrl: result.keysCellUrl,
    invite: result.invite,
  });
}
