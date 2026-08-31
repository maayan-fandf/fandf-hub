import { NextResponse } from "next/server";
import { currentUserEmail } from "@/lib/appsScript";
import { crmAccountCandidates } from "@/lib/crmData";
import { readKeysCached } from "@/lib/keys";
import { driveFolderOwner } from "@/lib/sa";
import { getSignedClients, getSignedClientsSehel } from "@/lib/signedClients";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The clients behind a project's מכירות number, fetched on demand.
 *
 *   GET /api/crm/signed?project=&company=&from=YYYY-MM-DD&to=YYYY-MM-DD
 *     → { ok, total, withJourney, clients: [...] }
 *
 * ON DEMAND, and that is the reason this is an endpoint rather than a field
 * on the report payload. It is the one surface in the hub that returns a
 * lead's name and phone; putting that on the page would place customer PII
 * in the RSC flight payload — and in view-source — for every viewer on
 * every load. Here it travels only when someone opens the section.
 *
 * WHO MAY READ IT: staff on any project, and a client on the projects they
 * are listed on (Keys col E). Clients were excluded outright until
 * 2026-08-31; the owner opened חוזים to them on the grounds that these are
 * the buyers of their own project. The per-project check is what keeps that
 * from becoming "any client can read any developer's buyer list".
 *
 * NOT windowed. `client_status` is a snapshot with no signing date in the
 * warehouse, so a date filter would only ask "which leads created in this
 * window have since signed" — nearly always nobody, since signing takes
 * months. from/to are still accepted and validated for call-site symmetry
 * with the other CRM endpoints, and ignored.
 *
 * BMBY and Sehel. Each writes the sale in its own field and vocabulary, so
 * each has its own reader; both return the same shape. Salesforce is out —
 * no journey table and no comparable stage field — and returns ok:true with
 * an empty list rather than an error, so the panel can say why.
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

  // Who may read THIS project's customers. Staff keep the domain blanket
  // they have everywhere else. A client is allowed too (owner decision
  // 2026-08-31 — these are the buyers of their own project), but only for
  // the projects they are actually listed on: without the per-project
  // check, dropping the domain gate would have let any signed-in client
  // read any other developer's buyer names and phones by editing the
  // ?project= parameter. getAccessScope is the same primitive the rest of
  // the app gates on, and it matches a client through Keys col E.
  if (!email.endsWith("@fandf.co.il")) {
    const { getAccessScope } = await import("@/lib/tasksDirect");
    const scope = await getAccessScope(email).catch(() => null);
    if (!scope || (!scope.isAdmin && !scope.accessibleProjects.has(project))) {
      return NextResponse.json(
        { ok: false, error: "Forbidden" },
        { status: 403 },
      );
    }
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
    // Salesforce alone is out: its CRM tab has no journey table and no stage
    // field of this shape. Sehel was excluded at first on the belief that
    // only BMBY carries a journey — wrong, sehel_touches holds 127,765 rows,
    // more than BMBY's — so it gets its own reader instead.
    // The cell can name MORE THAN ONE platform: חמסה/רייסדור reads
    // "bmby, sehel" because that project's clients live in both. An equality
    // check rejected the whole string and the section came back empty on a
    // project that has data in two places — so the cell is parsed, not
    // compared.
    const platforms = platform
      .split(/[,;/|]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const wantsBmby = platforms.length === 0 || platforms.includes("bmby");
    const wantsSehel = platforms.includes("sehel");
    if (!wantsBmby && !wantsSehel) {
      return NextResponse.json({
        ok: true,
        total: 0,
        opportunities: 0,
        withJourney: 0,
        clients: [],
        reason: "unsupported-platform",
        platform,
      });
    }

    const accounts = crmAccountCandidates(crmAccount);
    const parts = (
      await Promise.all([
        wantsBmby ? getSignedClients({ crmAccounts: accounts }) : null,
        wantsSehel ? getSignedClientsSehel({ crmAccounts: accounts }) : null,
      ])
    ).filter((x): x is NonNullable<typeof x> => !!x);
    // Signed first within each reader already; concatenating keeps BMBY's
    // ahead of Sehel's rather than interleaving two ID formats. The counts
    // add because the two CRMs hold DIFFERENT clients — a project on both
    // splits its customers between them, it does not duplicate them.
    const res = parts.length
      ? parts.length === 1
        ? parts[0]
        : {
            clients: parts.flatMap((p) => p.clients),
            total: parts.reduce((n, p) => n + p.total, 0),
            opportunities: parts.reduce((n, p) => n + p.opportunities, 0),
            withJourney: parts.reduce((n, p) => n + p.withJourney, 0),
          }
      : null;
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
