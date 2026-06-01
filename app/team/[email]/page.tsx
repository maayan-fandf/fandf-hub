export async function generateMetadata({
  params,
}: {
  params: Promise<{ email: string }>;
}) {
  const { email } = await params;
  const decoded = decodeURIComponent(email);
  // Try the person's display name; fall back to their email local part.
  try {
    const { getDirectoryUser } = await import("@/lib/userDirectory");
    const u = await getDirectoryUser(decoded);
    if (u?.fullName) return { title: u.fullName };
  } catch {}
  return { title: decoded.split("@")[0] };
}

import Link from "next/link";
import Image from "next/image";
import { notFound, redirect } from "next/navigation";
import { currentUserEmail, getMyProjects, tasksList } from "@/lib/appsScript";
import { tasksPeopleListDirect } from "@/lib/tasksDirect";
import { getDirectoryUser } from "@/lib/userDirectory";
import GmailIcon from "@/components/GmailIcon";
import WhatsAppIcon from "@/components/WhatsAppIcon";
import TeamActiveTaskChip from "@/components/TeamActiveTaskChip";
import { roleEmoji } from "@/components/RoleChip";
import { deriveInProgressTime } from "@/lib/inProgressTime";
import type { ActiveTask } from "@/lib/teamData";
import type { WorkTask } from "@/lib/appsScript";

export const dynamic = "force-dynamic";

/**
 * /team/[email] — single-person profile page.
 *
 * Same gate as /team (clients bounced to /). The email param is the
 * teammate's address (URL-encoded). Page fetches:
 *   - their TasksPerson row (name + role)
 *   - Workspace Directory enrichment (job title, phones, photo)
 *   - their OPEN tasks (awaiting_handling / in_progress /
 *     awaiting_clarification / awaiting_approval, plus blocked) — grouped
 *     by status so the page reads like a personal kanban
 *   - tasks they SHIPPED in the last 30 days (an extended velocity
 *     window vs. the 7-day chip on the grid card)
 *   - a project-rollup of all of the above
 *
 * Heavy data: tasksList is called once with no filters and partitioned
 * client-side (server-side, technically — we're in an RSC). Cheaper
 * than two separate filtered calls, and lets us share the same
 * `relevant_to_me` style OR semantics — any task where they're
 * author / approver / project_manager / assignee shows up.
 */

const STATUS_GROUPS: Array<{
  key: WorkTask["status"];
  label: string;
  emoji: string;
}> = [
  { key: "awaiting_approval", label: "ממתינות לאישור", emoji: "⏳" },
  { key: "in_progress", label: "בעבודה", emoji: "🛠️" },
  { key: "awaiting_handling", label: "ממתינות לטיפול", emoji: "📋" },
  { key: "awaiting_clarification", label: "בבירור", emoji: "❓" },
  { key: "blocked", label: "חסומות", emoji: "⛔" },
];

function involves(t: WorkTask, lc: string): boolean {
  if ((t.author_email || "").toLowerCase() === lc) return true;
  if ((t.approver_email || "").toLowerCase() === lc) return true;
  if ((t.project_manager_email || "").toLowerCase() === lc) return true;
  return (t.assignees || []).some(
    (a) => String(a).toLowerCase().trim() === lc,
  );
}

export default async function TeamPersonPage({
  params,
}: {
  params: Promise<{ email: string }>;
}) {
  const { email: rawEmail } = await params;
  const target = decodeURIComponent(rawEmail).toLowerCase().trim();
  if (!target.includes("@")) notFound();

  const me = (await currentUserEmail().catch(() => "")) || "";
  if (!me) redirect("/signin?next=/team/" + rawEmail);

  // Same client gate as /team — keeps client users out of the
  // internal directory.
  const access = await getMyProjects().catch(() => null);
  const isClientOnly =
    !!access?.isClient &&
    !access?.isAdmin &&
    !access?.isStaff &&
    !access?.isInternal;
  if (isClientOnly) redirect("/");

  const [peopleRes, dir, tasksRes] = await Promise.all([
    tasksPeopleListDirect(me).catch(() => ({
      ok: true as const,
      people: [],
    })),
    getDirectoryUser(target).catch(() => null),
    tasksList({ include_umbrellas: false }).catch(() => ({
      ok: true,
      tasks: [] as WorkTask[],
      count: 0,
    })),
  ]);

  const person = peopleRes.people.find(
    (p) => (p.email || "").toLowerCase() === target,
  );
  // No row in names-to-emails AND no Workspace profile → almost
  // certainly a bad URL. notFound() is the right shape.
  if (!person && !dir) notFound();

  const displayName =
    person?.he_name || dir?.fullName || person?.name || target;
  const role = (person?.role || "").trim();
  const emoji = roleEmoji(role);
  const tasks: WorkTask[] = tasksRes.tasks ?? [];
  const involved = tasks.filter((t) => involves(t, target));

  // Group by status for the kanban-style sections below. Done +
  // cancelled drop out (they live in their own "shipped lately"
  // strip; we don't want the page to be 80% closed work).
  const byStatus = new Map<WorkTask["status"], WorkTask[]>();
  for (const t of involved) {
    if (!byStatus.has(t.status)) byStatus.set(t.status, []);
    byStatus.get(t.status)!.push(t);
  }

  // Shipped in the last 30 days — pulled from involved so it credits
  // them regardless of which role they played on the task. Sort
  // newest-first.
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recentlyShipped = involved
    .filter(
      (t) =>
        t.status === "done" &&
        Date.parse(t.updated_at || "") > cutoff,
    )
    .sort((a, b) =>
      (b.updated_at || "").localeCompare(a.updated_at || ""),
    )
    .slice(0, 12);

  // Project rollup across every involved task (open + recently shipped).
  // Sorted by total tasks descending so the most-frequent projects
  // surface first — same intent as the topProjects on the grid card,
  // just unbounded here.
  const projCounts = new Map<string, number>();
  for (const t of involved) {
    if (!t.project) continue;
    projCounts.set(t.project, (projCounts.get(t.project) ?? 0) + 1);
  }
  const projects = Array.from(projCounts.entries()).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "he"),
  );

  const authQ = me ? `&authuser=${encodeURIComponent(me)}` : "";
  const gmailComposeUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(target)}${authQ}`;
  const calendarUrl = `https://calendar.google.com/calendar/u/0/r/eventedit?add=${encodeURIComponent(target)}${authQ}`;
  const whatsappUrl = dir?.mobilePhoneE164
    ? `https://wa.me/${dir.mobilePhoneE164}`
    : "";
  const telTarget = dir?.mobilePhoneE164
    ? `+${dir.mobilePhoneE164}`
    : dir?.mobilePhone || dir?.workPhone || "";
  const tasksUrl = `/tasks?assignee=${encodeURIComponent(target)}`;
  const newTaskUrl = `/tasks/new?assignees=${encodeURIComponent(target)}`;
  const photoUrl = `/api/avatar/${encodeURIComponent(target)}`;

  const totalOpen =
    (byStatus.get("awaiting_handling")?.length ?? 0) +
    (byStatus.get("in_progress")?.length ?? 0);
  const totalApproval =
    byStatus.get("awaiting_approval")?.length ?? 0;
  const totalStuck =
    byStatus.get("awaiting_clarification")?.length ?? 0;

  // Live "currently working on" — same derivation as the team-grid
  // aggregator in lib/teamData.ts: pick the in_progress task whose
  // current un-paused stretch started most recently. The detail page
  // builds its data independently (so it can show the full kanban),
  // so we redo this lookup here instead of plumbing it through.
  let activeTask: ActiveTask | null = null;
  for (const t of byStatus.get("in_progress") || []) {
    const ip = deriveInProgressTime(
      t.status_history || [],
      t.status,
      t.time_pauses || [],
    );
    if (!ip.isRunning || !ip.runningSinceIso) continue;
    if (!activeTask || activeTask.runningSinceIso < ip.runningSinceIso) {
      activeTask = {
        id: t.id,
        title: t.title || t.id,
        project: t.project || "",
        minutes: ip.minutes,
        runningSinceIso: ip.runningSinceIso,
      };
    }
  }

  return (
    <main className="container team-detail-page">
      <div className="team-detail-crumbs">
        <Link href="/team">← צוות</Link>
      </div>

      <header className="team-detail-head">
        <span className="team-detail-avatar" aria-hidden>
          <Image
            src={photoUrl}
            alt=""
            width={96}
            height={96}
            unoptimized
            priority
          />
        </span>
        <div className="team-detail-id">
          <h1 className="team-detail-name" dir="auto">
            {displayName}
          </h1>
          {(dir?.jobTitle || role) && (
            <div className="team-detail-role">
              {dir?.jobTitle && <span dir="auto">{dir.jobTitle}</span>}
              {dir?.jobTitle && role && (
                <span className="team-card-sep" aria-hidden>
                  ·
                </span>
              )}
              {role && (
                <span className="team-card-rolepill">
                  {emoji && <span aria-hidden>{emoji}</span>}
                  <span dir="auto">{role}</span>
                </span>
              )}
            </div>
          )}
          {dir?.department && dir.department !== dir.jobTitle && (
            <div className="team-detail-dept" dir="auto">
              {dir.department}
            </div>
          )}
          <div className="team-detail-email">
            <a href={`mailto:${target}`} dir="ltr">
              {target}
            </a>
          </div>
        </div>
      </header>

      <div
        className="team-card-actions team-detail-actions"
        role="group"
        aria-label="פעולות"
      >
        <a
          className="team-card-action"
          href={gmailComposeUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          <GmailIcon size="16" />
          <span>Gmail</span>
        </a>
        {whatsappUrl && (
          <a
            className="team-card-action team-card-action-whatsapp"
            href={whatsappUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <WhatsAppIcon size="16" />
            <span>WhatsApp</span>
          </a>
        )}
        {telTarget && (
          <a className="team-card-action" href={`tel:${telTarget}`}>
            <span aria-hidden>📞</span>
            <span>חיוג</span>
          </a>
        )}
        <a
          className="team-card-action"
          href={calendarUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          <span aria-hidden>📅</span>
          <span>פגישה</span>
        </a>
        <a className="team-card-action" href={tasksUrl}>
          <span aria-hidden>📋</span>
          <span>כל המשימות</span>
        </a>
        <a className="team-card-action" href={newTaskUrl}>
          <span aria-hidden>➕</span>
          <span>הקצה משימה</span>
        </a>
      </div>

      {activeTask && (
        <TeamActiveTaskChip task={activeTask} variant="detail" />
      )}

      <div className="team-detail-summary" aria-label="סיכום עומס">
        <span className="team-card-chip team-card-chip-open">
          🔥 <b>{totalOpen}</b> פעילות
        </span>
        {totalApproval > 0 && (
          <span className="team-card-chip team-card-chip-approve">
            ⏳ <b>{totalApproval}</b> ממתינות לאישור
          </span>
        )}
        {totalStuck > 0 && (
          <span className="team-card-chip team-card-chip-stuck">
            ❓ <b>{totalStuck}</b> בבירור
          </span>
        )}
        {recentlyShipped.length > 0 && (
          <span className="team-card-chip team-card-chip-done">
            ✅ <b>{recentlyShipped.length}</b> נסגרו ב-30 ימים האחרונים
          </span>
        )}
      </div>

      <section className="team-detail-section">
        <h2>📋 משימות פתוחות</h2>
        {STATUS_GROUPS.map((g) => {
          const ts = byStatus.get(g.key) || [];
          if (ts.length === 0) return null;
          ts.sort((a, b) =>
            (b.updated_at || "").localeCompare(a.updated_at || ""),
          );
          return (
            <div key={g.key} className="team-detail-statusgroup">
              <h3 className="team-detail-statusgroup-title">
                <span aria-hidden>{g.emoji}</span> {g.label}
                <span className="team-detail-statusgroup-count">
                  ({ts.length})
                </span>
              </h3>
              <ul className="team-detail-tasklist">
                {ts.map((t) => (
                  <li key={t.id} className="team-detail-tasklist-item">
                    <Link
                      href={`/tasks/${encodeURIComponent(t.id)}`}
                      className="team-detail-tasklist-link"
                    >
                      <span className="team-detail-tasklist-title" dir="auto">
                        {t.title || t.id}
                      </span>
                      {t.project && (
                        <span
                          className="team-detail-tasklist-project"
                          dir="auto"
                        >
                          {t.project}
                        </span>
                      )}
                      {t.priority === 1 && (
                        <span
                          className="tasks-priority-pill p1"
                          title="דחיפות גבוהה"
                        >
                          🔥
                        </span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        {STATUS_GROUPS.every(
          (g) => (byStatus.get(g.key)?.length ?? 0) === 0,
        ) && (
          <div className="team-empty">אין משימות פתוחות כרגע. 🎉</div>
        )}
      </section>

      {recentlyShipped.length > 0 && (
        <section className="team-detail-section">
          <h2>✅ נסגרו לאחרונה (30 ימים)</h2>
          <ul className="team-detail-tasklist team-detail-tasklist-compact">
            {recentlyShipped.map((t) => (
              <li key={t.id} className="team-detail-tasklist-item">
                <Link
                  href={`/tasks/${encodeURIComponent(t.id)}`}
                  className="team-detail-tasklist-link"
                >
                  <span className="team-detail-tasklist-title" dir="auto">
                    {t.title || t.id}
                  </span>
                  {t.project && (
                    <span
                      className="team-detail-tasklist-project"
                      dir="auto"
                    >
                      {t.project}
                    </span>
                  )}
                  <span className="team-detail-tasklist-date">
                    {(t.updated_at || "").slice(0, 10)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {projects.length > 0 && (
        <section className="team-detail-section">
          <h2>📁 פרויקטים</h2>
          <div className="team-detail-projects">
            {projects.map(([name, count]) => (
              <Link
                key={name}
                href={`/projects/${encodeURIComponent(name)}`}
                className="team-detail-project"
                prefetch={false}
              >
                <span dir="auto">{name}</span>
                <span className="team-detail-project-count">{count}</span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
