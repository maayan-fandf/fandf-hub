import Link from "next/link";
import { redirect } from "next/navigation";
import { getMyProjects, currentUserEmail, tasksList } from "@/lib/appsScript";
import { readTimeLog, type TimeLogRow } from "@/lib/timeLog";
import { deriveInProgressTime } from "@/lib/inProgressTime";
import TimeReport from "@/components/TimeReport";

export const dynamic = "force-dynamic";

/**
 * Time-tracking report. Two sources, merged:
 *  1. The TimeLog ledger — one row per manual per-person entry.
 *  2. Per-task STATUS time — for every task, the (override-aware)
 *     time it spent in status בעבודה, derived from status_history +
 *     pauses (lib/inProgressTime). One synthetic row per task,
 *     attributed to the month of its last status change, tagged
 *     logged_by "(סטטוס)".
 * Grouped by company × month with sub-totals + a grand total + CSV.
 * Informational only: time does NOT drive a charge; client invoicing
 * stays on the flat Pricingsetup price (/admin/billing).
 */
export default async function TimeAdminPage() {
  let isAdmin = false;
  try {
    const me = await getMyProjects();
    isAdmin = me.isAdmin;
  } catch {
    isAdmin = false;
  }
  if (!isAdmin) redirect("/");

  const adminEmail = await currentUserEmail();

  const [ledger, taskRows] = await Promise.all([
    readTimeLog(adminEmail).catch(() => [] as TimeLogRow[]),
    tasksList()
      .then((r) => r.tasks ?? [])
      .catch(() => []),
  ]);

  // taskId → task, for joining the task name / brief / worker onto
  // every row (the ledger tab doesn't store those). Worker = the
  // task's assignee(s); shown as email local-parts like the rest of
  // the report.
  const taskById = new Map(taskRows.map((t) => [t.id, t]));
  const workerOf = (emails: string[] | undefined): string =>
    (emails || []).map((e) => e.split("@")[0]).join(", ");

  // Accumulated status-time above this (and not manually corrected) is
  // almost certainly a task left in ׳בעבודה׳ without real work (e.g.
  // over a weekend) → flag it ⚠ for review. Tunable one-liner.
  const REVIEW_OVER_MINUTES = 24 * 60; // 24h elapsed in-progress

  // Synthesize one status-time row per task (override wins over the
  // status_history-derived value; umbrellas have no own work).
  const statusRows: TimeLogRow[] = [];
  for (const t of taskRows) {
    if (t.is_umbrella) continue;
    const overridden = t.inprogress_minutes != null;
    const ip = deriveInProgressTime(
      t.status_history || [],
      t.status,
      t.time_pauses || [],
    );
    const minutes = overridden ? (t.inprogress_minutes as number) : ip.minutes;
    const running = !overridden && ip.isRunning;
    const paused = !overridden && ip.isPaused;
    // Skip empties — but keep a just-started running/paused task even
    // at 0 min so it still surfaces for the quick-pause indicator.
    if ((!minutes || minutes <= 0) && !running && !paused) continue;
    // Attribute to the month of the most recent status change (fall
    // back to updated/created) — fuzzy but fine for an informational
    // report; the note explains the source.
    const hist = t.status_history || [];
    const when =
      (hist.length ? hist[hist.length - 1].at : "") ||
      t.updated_at ||
      t.created_at ||
      "";
    statusRows.push({
      loggedAt: when,
      month: String(when).slice(0, 7),
      taskId: t.id,
      company: t.company,
      project: t.project,
      departments: (t.departments || []).join(", "),
      kind: t.kind,
      minutes,
      note:
        "זמן בסטטוס ׳בעבודה׳" +
        (t.inprogress_minutes != null ? " (נערך ידנית)" : ""),
      loggedBy: "(סטטוס)",
      title: t.title,
      brief: t.campaign,
      worker: workerOf(t.assignees),
      running,
      paused,
      needsReview: !overridden && minutes > REVIEW_OVER_MINUTES,
    });
  }

  // Join task name / brief / worker onto the manual ledger rows too.
  const enrichedLedger = ledger.map((r) => {
    const t = taskById.get(r.taskId);
    return t
      ? {
          ...r,
          title: t.title,
          brief: t.campaign,
          worker: workerOf(t.assignees),
        }
      : r;
  });

  const rows = [...enrichedLedger, ...statusRows];

  return (
    <main className="container">
      <header className="page-header">
        <div>
          <h1>
            <span className="emoji" aria-hidden>⏱️</span>
            מעקב זמן
          </h1>
          <div className="subtitle">
            <Link href="/admin">→ ניהול</Link> ·{" "}
            <Link href="/admin/billing">🧾 חיובים ללקוח</Link> · תיעוד ידני
            (<code>TimeLog</code>) + זמן אוטומטי בסטטוס ״בעבודה״ לכל משימה
            (גובר עליו ערך שנערך ידנית). סינון לפי חודש + חברה, סכום זמן,
            וייצוא CSV. הזמן הוא מידע בלבד — אינו משפיע על החיוב ללקוח.
          </div>
        </div>
      </header>

      <TimeReport rows={rows} />
    </main>
  );
}
