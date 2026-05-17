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

  // Synthesize one status-time row per task (override wins over the
  // status_history-derived value; umbrellas have no own work).
  const statusRows: TimeLogRow[] = [];
  for (const t of taskRows) {
    if (t.is_umbrella) continue;
    const minutes =
      t.inprogress_minutes != null
        ? t.inprogress_minutes
        : deriveInProgressTime(
            t.status_history || [],
            t.status,
            t.time_pauses || [],
          ).minutes;
    if (!minutes || minutes <= 0) continue;
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
    });
  }

  const rows = [...ledger, ...statusRows];

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
