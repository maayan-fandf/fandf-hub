import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getMyProjects, currentUserEmail } from "@/lib/appsScript";
import {
  listTaskFormSchemaRows,
  replaceTaskFormSchema,
  type TaskFormSchemaRow,
} from "@/lib/taskFormSchema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin endpoint backing /admin/task-form-schema. Sheet ↔ UI both ways:
 *
 * GET — fresh read of every row in the TaskFormSchema tab.
 * POST { rows: [{department, kind, templateDocId?}, ...] } — full
 *   replacement of the data area below the header. Single-shot
 *   semantics: the editor always sends the complete table on save, so
 *   the server doesn't need to diff. Empty rows / blank fields are
 *   stripped. templateDocId is optional and round-trips as-is for the
 *   inline-template feature; missing → empty string in the sheet.
 */

async function gateAdmin(): Promise<{ adminEmail: string } | NextResponse> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }
  const me = await getMyProjects().catch(() => null);
  if (!me?.isAdmin) {
    return NextResponse.json(
      { ok: false, error: "Admin only" },
      { status: 403 },
    );
  }
  return { adminEmail: email };
}

export async function GET() {
  const gate = await gateAdmin();
  if (gate instanceof NextResponse) return gate;
  try {
    const rows = await listTaskFormSchemaRows(gate.adminEmail);
    return NextResponse.json({ ok: true, rows });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const gate = await gateAdmin();
  if (gate instanceof NextResponse) return gate;
  let body: { rows?: TaskFormSchemaRow[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }
  const incoming = Array.isArray(body.rows) ? body.rows : [];
  const cleaned: TaskFormSchemaRow[] = [];
  const seen = new Set<string>();
  for (const r of incoming) {
    const department = String(r.department ?? "").trim();
    const kind = String(r.kind ?? "").trim();
    if (!department || !kind) continue;
    const key = `${department}|${kind}`;
    if (seen.has(key)) continue; // drop duplicates
    seen.add(key);
    // templateDocId is optional. Accept either a bare doc id or a
    // full Drive URL — sanitize the URL down to the id so the sheet
    // stays compact. Missing / unparseable → '' (no template).
    const templateDocId = sanitizeTemplateDocId(r.templateDocId);
    cleaned.push({ department, kind, templateDocId });
  }
  try {
    await replaceTaskFormSchema(gate.adminEmail, cleaned);
    return NextResponse.json({ ok: true, rows: cleaned });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

/** Accept either a bare Drive id or any of the common Drive URL
 *  shapes — folder URLs ("/drive/folders/<id>"), file URLs
 *  ("/file/d/<id>/view"), doc URLs ("/document/d/<id>/edit"), etc.
 *  Returns just the id portion. Anything else → ''.
 *
 *  The new (post-2026-05-09) template model stores FOLDER ids in the
 *  template_doc_id column — admins paste the kind folder URL — so
 *  we must accept the `/folders/<id>` shape too. */
function sanitizeTemplateDocId(input: unknown): string {
  const s = String(input ?? "").trim();
  if (!s) return "";
  // Drive ids are [\w-]{20,} (alphanumeric + - + _). Bare-id input.
  if (/^[\w-]{20,}$/.test(s)) return s;
  // URL — match against folder + file + doc shapes.
  const m = s.match(/(?:[?&]id=|\/d\/|\/folders\/)([\w-]{20,})/);
  return m?.[1] ?? "";
}
