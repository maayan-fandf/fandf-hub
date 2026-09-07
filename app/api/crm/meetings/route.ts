import { NextResponse } from "next/server";
import { currentUserEmail } from "@/lib/appsScript";
import { crmAccountCandidates } from "@/lib/crmData";
import { readKeysCached } from "@/lib/keys";
import { driveFolderOwner } from "@/lib/sa";
import { getHeldMeetings } from "@/lib/heldMeetings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The meetings a project actually HELD in the report window, with the file
 * behind each one.
 *
 *   GET /api/crm/meetings?project=&company=&from=YYYY-MM-DD&to=YYYY-MM-DD
 *     → { ok, total, clientsMet, withNotes, meetings: [...], clients: [...] }
 *
 * On demand for the same reason /api/crm/signed is: it returns customer
 * names, phones and the salesperson's write-up of the conversation. Putting
 * that on the report payload would place it in the RSC flight — and in
 * view-source — for every viewer on every load. Here it travels only when
 * someone opens the section.
 *
 * WHO MAY READ IT: exactly who may read חוזים — staff on any project, and a
 * client only on the projects they are listed on (Keys col E). The two
 * surfaces expose the same customers, so a difference between their gates
 * would be a way around whichever is stricter.
 *
 * WINDOWED, unlike /api/crm/signed, and legitimately so: a meeting carries
 * the date it happened. That endpoint is unwindowed because a signature has
 * no date anywhere in the warehouse; this one is windowed because
 * `appointment_date` is exactly the thing being asked about.
 */

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  const email = await currentUserEmail()
    .then((e) => e.toLowerCase().trim())
    .catch(() => "");
  if (!email) {
    return NextResponse.json({ ok: false, error: "Not authenticated" }, { status: 401 });
  }
  let project = "";
  let company = "";
  let from = "";
  let to = "";
  try {
    const url = new URL(req.url);
    project = (url.searchParams.get("project") || "").trim();
    company = (url.searchParams.get("company") || "").trim();
    from = (url.searchParams.get("from") || "").trim();
    to = (url.searchParams.get("to") || "").trim();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request URL" }, { status: 400 });
  }
  if (!project || !ISO.test(from) || !ISO.test(to)) {
    return NextResponse.json(
      { ok: false, error: "project, from and to (YYYY-MM-DD) are required" },
      { status: 400 },
    );
  }

  // Same per-project gate as /api/crm/signed. Without it, dropping the
  // domain blanket would let any signed-in client read another developer's
  // customers by editing ?project=.
  if (!email.endsWith("@fandf.co.il")) {
    const { getAccessScope } = await import("@/lib/tasksDirect");
    const scope = await getAccessScope(email).catch(() => null);
    if (!scope || (!scope.isAdmin && !scope.accessibleProjects.has(project))) {
      return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
    }
  }

  try {
    // Match on (project, company), so a project name shared by two companies
    // cannot hand back the wrong account's meetings.
    const { headers, rows } = await readKeysCached(driveFolderOwner());
    const iProj = headers.indexOf("פרוייקט");
    const iCo = headers.indexOf("חברה");
    const iCrm = headers.indexOf("CRM");
    const iPlat = headers.indexOf("CRM platform");
    if (iProj < 0 || iCrm < 0) {
      return NextResponse.json({ ok: false, error: "Keys unavailable" }, { status: 500 });
    }
    let crmAccount = "";
    let platform = "";
    for (const r of rows) {
      const rp = String((r as unknown[])[iProj] ?? "").trim();
      if (rp !== project) continue;
      const rc = iCo >= 0 ? String((r as unknown[])[iCo] ?? "").trim() : "";
      if (rc && company && rc !== company) continue;
      crmAccount = String((r as unknown[])[iCrm] ?? "").trim();
      platform =
        iPlat >= 0 ? String((r as unknown[])[iPlat] ?? "").trim().toLowerCase() : "";
      break;
    }
    if (!crmAccount) {
      return NextResponse.json({
        ok: true,
        total: 0,
        clientsMet: 0,
        withNotes: 0,
        meetings: [],
        clients: [],
        reason: "no-crm",
      });
    }

    // BMBY only. Sehel and Salesforce have no per-meeting outcome joined to
    // a touch trail, so there is nothing to open behind a row — the panel
    // says so rather than rendering an empty table that reads as "no
    // meetings were held".
    const platforms = platform
      .split(/[,;/|]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (platforms.length > 0 && !platforms.includes("bmby")) {
      return NextResponse.json({
        ok: true,
        total: 0,
        clientsMet: 0,
        withNotes: 0,
        meetings: [],
        clients: [],
        reason: "unsupported-platform",
        platform,
      });
    }

    const res = await getHeldMeetings({
      crmAccounts: crmAccountCandidates(crmAccount),
      from,
      to,
    });
    if (!res) {
      return NextResponse.json({
        ok: true,
        total: 0,
        clientsMet: 0,
        withNotes: 0,
        meetings: [],
        clients: [],
        reason: "unavailable",
      });
    }
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    console.warn(
      `[api/crm/meetings] failed for "${project}": ${e instanceof Error ? e.message : String(e)}`,
    );
    return NextResponse.json({ ok: false, error: "Lookup failed" }, { status: 500 });
  }
}
