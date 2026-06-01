import { redirect } from "next/navigation";
import Link from "next/link";
import { currentUserEmail, getMyProjects } from "@/lib/appsScript";
import { getTeamRoster } from "@/lib/teamData";
import TeamPersonCard from "@/components/TeamPersonCard";

export const metadata = { title: "צוות" };

export const dynamic = "force-dynamic";

/**
 * /team — the internal staff directory.
 *
 * Renders one card per @fandf.co.il teammate with workload chips,
 * action row (Gmail / WhatsApp / dial / calendar / tasks), and a
 * link to their full profile at /team/[email].
 *
 * Access: staff-only. Clients (col-E-only users in
 * names-to-emails) get bounced to the home page — same gate
 * pattern as /tasks/[id], since the team directory is an internal
 * surface and clients have no business seeing the rest of the
 * roster.
 *
 * Filters via URL params (so the state is shareable + back-button
 * friendly):
 *   - `dept=מדיה` — narrow by Workspace Directory department
 *   - `role=copywriter` — narrow by sheet Role
 *   - `q=omer` — free-text search on name / email / role / job title
 */
export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<{ dept?: string; role?: string; q?: string }>;
}) {
  const me = (await currentUserEmail().catch(() => "")) || "";
  if (!me) redirect("/signin?next=/team");

  // Client-user gate. getMyProjects returns isClient/isAdmin/isStaff/isInternal
  // — the exact same shape /tasks uses for its gate.
  const access = await getMyProjects().catch(() => null);
  const isClientOnly =
    !!access?.isClient &&
    !access?.isAdmin &&
    !access?.isStaff &&
    !access?.isInternal;
  if (isClientOnly) redirect("/");

  const sp = await searchParams;
  const qDept = (sp.dept || "").trim().toLowerCase();
  const qRole = (sp.role || "").trim().toLowerCase();
  const qText = (sp.q || "").trim().toLowerCase();

  const roster = await getTeamRoster(me).catch(() => []);

  // Department aggregation — the chip strip at the top doubles as
  // both a count summary AND a one-click filter. Falls back to "אחר"
  // when Workspace Directory hasn't filled in `department` so every
  // teammate is accounted for somewhere.
  const deptCounts = new Map<string, number>();
  for (const p of roster) {
    const d = p.department || "אחר";
    deptCounts.set(d, (deptCounts.get(d) ?? 0) + 1);
  }
  const depts = Array.from(deptCounts.entries()).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "he"),
  );

  const filtered = roster.filter((p) => {
    if (qDept) {
      const d = (p.department || "אחר").toLowerCase();
      if (d !== qDept) return false;
    }
    if (qRole) {
      if ((p.role || "").toLowerCase() !== qRole) return false;
    }
    if (qText) {
      const hay = [
        p.email,
        p.fullName,
        p.heName,
        p.role,
        p.jobTitle,
        p.department,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!hay.includes(qText)) return false;
    }
    return true;
  });

  // Build the URL for clearing all filters — `/team` alone keeps the
  // form values empty. Used on both the "נקה" button and the active
  // department chip's deselect path.
  const clearHref = "/team";

  return (
    <main className="container team-page">
      <header className="page-header">
        <div>
          <h1>👥 צוות</h1>
          <p className="subtitle">
            {roster.length} אנשי צוות · {filtered.length} מוצגים
          </p>
        </div>
      </header>

      <form className="team-filterbar" action="/team" method="get">
        <input
          className="team-filter-search"
          type="search"
          name="q"
          placeholder="חפש לפי שם / אימייל / תפקיד…"
          defaultValue={sp.q || ""}
          dir="auto"
        />
        {qRole && <input type="hidden" name="role" value={sp.role || ""} />}
        {qDept && <input type="hidden" name="dept" value={sp.dept || ""} />}
        <button type="submit" className="btn-ghost btn-sm">
          חפש
        </button>
        {(qDept || qRole || qText) && (
          <Link href={clearHref} className="btn-ghost btn-sm">
            נקה
          </Link>
        )}
      </form>

      <div className="team-dept-chips" role="group" aria-label="לפי מחלקה">
        {depts.map(([dept, count]) => {
          const isActive = qDept === dept.toLowerCase();
          const params = new URLSearchParams();
          if (!isActive) params.set("dept", dept);
          if (qRole) params.set("role", sp.role || "");
          if (qText) params.set("q", sp.q || "");
          const href = `/team${params.toString() ? "?" + params.toString() : ""}`;
          return (
            <Link
              key={dept}
              href={href}
              className={`team-dept-chip${isActive ? " is-active" : ""}`}
              prefetch={false}
            >
              <span dir="auto">{dept}</span>
              <span className="team-dept-count">{count}</span>
            </Link>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <div className="team-empty">
          {qText || qDept || qRole
            ? "אין תוצאות לסינון הנוכחי."
            : "לא נמצאו אנשי צוות פנימיים."}
        </div>
      ) : (
        <div className="team-grid">
          {filtered.map((p) => (
            <TeamPersonCard key={p.email} person={p} viewerEmail={me} />
          ))}
        </div>
      )}
    </main>
  );
}
