import { NextResponse } from "next/server";
import { readKeysCached } from "@/lib/keys";
import { createChatSpaceForProject } from "@/lib/chatSpaceCreate";
import { driveFolderOwner } from "@/lib/sa";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One-off batch space (re)provisioner for the delete+recreate-as-
 * threaded migration. For every Keys project row it calls
 * createChatSpaceForProject (the proven path: with the flags on it
 * makes a THREADED + RESTRICTED space, invites the roster, and writes
 * the new URL back into Keys). createChatSpaceForProject is itself
 * idempotent — if a row's Chat Space cell still points at a real
 * space it returns that one instead of creating a duplicate. So the
 * intended sequence is: back up Keys cells → clear them → call this
 * with ?apply=1 → every row gets a fresh threaded space.
 *
 * Auth: same shared-secret as the crons (X-Cron-Token /
 * APPS_SCRIPT_API_TOKEN). Default = DRY PREVIEW (lists what it would
 * do, no mutation). Must pass ?apply=1 to actually create — the
 * dry-first discipline used everywhere in this migration.
 */
export async function POST(req: Request) {
  const expected = process.env.APPS_SCRIPT_API_TOKEN || "";
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "Server missing APPS_SCRIPT_API_TOKEN" },
      { status: 500 },
    );
  }
  const got =
    req.headers.get("x-cron-token") ||
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    "";
  if (got !== expected) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const apply = new URL(req.url).searchParams.get("apply") === "1";
  const admin = driveFolderOwner();

  // Explicit scope list. apply=1 REQUIRES a non-empty
  // body.projects[{project, company?}] — there is deliberately no
  // "recreate every Keys row" mode (that would spawn spaces for the
  // ~29 projects that intentionally never had one). The clear script
  // emits this exact list as a manifest.
  let wantProjects: { project: string; company?: string }[] | null = null;
  try {
    const body = (await req.json()) as
      | { projects?: { project?: string; company?: string }[] }
      | undefined;
    if (Array.isArray(body?.projects)) {
      wantProjects = body!.projects!
        .map((p) => ({
          project: String(p?.project ?? "").trim(),
          company: String(p?.company ?? "").trim(),
        }))
        .filter((p) => p.project);
    }
  } catch {
    wantProjects = null;
  }
  if (apply && (!wantProjects || wantProjects.length === 0)) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "apply=1 requires a non-empty body.projects [{project, company}] list (the recreate manifest from clear-keys-chat-space.mjs). Refusing to recreate all Keys rows.",
      },
      { status: 400 },
    );
  }

  let headers: string[];
  let rows: unknown[][];
  try {
    const k = await readKeysCached(admin);
    headers = k.headers;
    rows = k.rows;
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "Keys read failed: " + (e instanceof Error ? e.message : String(e)) },
      { status: 500 },
    );
  }
  const iProj = headers.indexOf("פרוייקט");
  const iCo = headers.indexOf("חברה");
  const iChat =
    headers.indexOf("Chat Space") >= 0
      ? headers.indexOf("Chat Space")
      : headers.indexOf("Chat Webhook");
  if (iProj < 0 || iChat < 0) {
    return NextResponse.json(
      { ok: false, error: "Keys missing פרוייקט or Chat Space column" },
      { status: 500 },
    );
  }

  const allRows: { project: string; company: string; cell: string }[] = [];
  for (const row of rows) {
    const project = String(row[iProj] ?? "").trim();
    if (!project) continue;
    allRows.push({
      project,
      company: iCo >= 0 ? String(row[iCo] ?? "").trim() : "",
      cell: String(row[iChat] ?? "").trim(),
    });
  }

  // Scope to the explicit manifest when provided (match on project,
  // and on company too when the manifest entry specifies one — Keys
  // has collisions like 4× כללי).
  const inScope = (t: { project: string; company: string }) =>
    !wantProjects ||
    wantProjects.some(
      (w) =>
        w.project === t.project &&
        (!w.company || w.company === t.company),
    );
  const targets = allRows.filter(inScope);

  if (!apply) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      note: "Preview only. ?apply=1 REQUIRES body.projects[] (the recreate manifest) — there is no recreate-all mode. createChatSpaceForProject is idempotent: a row whose Chat Space cell is still set returns the existing space, so clear the cells first to force fresh threaded spaces.",
      manifestProvided: !!wantProjects,
      scopedCount: targets.length,
      allKeysRowCount: allRows.length,
      targets,
    });
  }

  const results: {
    project: string;
    company: string;
    ok: boolean;
    spaceUri?: string;
    error?: string;
  }[] = [];
  for (const t of targets) {
    try {
      const r = await createChatSpaceForProject(
        admin,
        t.project,
        t.company || undefined,
      );
      if (r.ok) {
        results.push({
          project: t.project,
          company: t.company,
          ok: true,
          spaceUri: r.spaceUri,
        });
      } else {
        results.push({
          project: t.project,
          company: t.company,
          ok: false,
          error: r.error,
        });
      }
    } catch (e) {
      results.push({
        project: t.project,
        company: t.company,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  const created = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  return NextResponse.json({
    ok: failed === 0,
    dryRun: false,
    processed: results.length,
    created,
    failed,
    results,
  });
}

export async function GET(req: Request) {
  return POST(req);
}
