import { NextResponse } from "next/server";
import { currentUserEmail } from "@/lib/appsScript";
import { crmAccountCandidates } from "@/lib/crmData";
import { readKeysCached } from "@/lib/keys";
import { driveFolderOwner } from "@/lib/sa";
import { getSignedClients } from "@/lib/signedClients";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The clients behind a project's מכירות number, fetched on demand.
 *
 *   GET /api/crm/signed?project=&company=&from=YYYY-MM-DD&to=YYYY-MM-DD
 *     → { ok, total, withJourney, clients: [...] }
 *
 * INTERNAL ONLY, and that is the reason this is an endpoint rather than a
 * field on the report payload. It is the one surface in the hub that returns
 * a lead's name and phone; putting that on the page would place customer PII
 * in the RSC flight payload — and in view-source — for every viewer on every
 * load, including client users who can open the same project. Here it is
 * gated on an @fandf.co.il session and only travels when someone clicks.
 *
 * NOT windowed. `client_status` is a snapshot with no signing date in the
 * warehouse, so a date filter would only ask "which leads created in this
 * window have since signed" — nearly always nobody, since signing takes
 * months. from/to are still accepted and validated for call-site symmetry
 * with the other CRM endpoints, and ignored.
 *
 * BMBY only for now: the journey (`bmby_touches`) has no Sehel or Salesforce
 * equivalent, and a dossier with no journey is most of the point missing.
 * Returns ok:true with an empty list rather than an error for those, so the
 * panel can say why.
 */

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  // The app-wide resolver, not auth() directly: it falls back to
  // DEV_USER_EMAIL so this works locally, and that variable is not shipped
  // to production (verified against apphosting.yaml), so the fallback can
  // never widen access there.
  const email = await currentUserEmail()
    .then((e) => e.toLowerCase().trim())
    .catch(() => "");
  if (!email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }
  // Customer PII — staff only. A client user reaching this URL directly gets
  // the same answer as an anonymous one.
  if (!email.endsWith("@fandf.co.il")) {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
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

  try {
    // Resolve the project's CRM mapping the same way getCrmFunnelForProject
    // does — match on (project, company) so a name shared by two companies
    // cannot hand back the wrong account's customers.
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
      platform = iPlat >= 0
        ? String((r as unknown[])[iPlat] ?? "").trim().toLowerCase()
        : "";
      break;
    }
    if (!crmAccount) {
      return NextResponse.json({ ok: true, total: 0, withJourney: 0, clients: [], reason: "no-crm" });
    }
    if (platform && platform !== "bmby") {
      return NextResponse.json({
        ok: true,
        total: 0,
        withJourney: 0,
        clients: [],
        reason: "not-bmby",
        platform,
      });
    }

    const res = await getSignedClients({
      crmAccounts: crmAccountCandidates(crmAccount),
    });
    if (!res) {
      return NextResponse.json({ ok: true, total: 0, withJourney: 0, clients: [], reason: "unavailable" });
    }
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    console.warn(
      `[api/crm/signed] failed for "${project}": ${e instanceof Error ? e.message : String(e)}`,
    );
    return NextResponse.json({ ok: false, error: "Lookup failed" }, { status: 500 });
  }
}
