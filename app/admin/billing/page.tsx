import Link from "next/link";
import { redirect } from "next/navigation";
import { getMyProjects, currentUserEmail, tasksList } from "@/lib/appsScript";
import { readPricingLog, type PricingLogRow } from "@/lib/pricingLog";

export const metadata = { title: "חיובים" };
import BillingReport from "@/components/BillingReport";

export const dynamic = "force-dynamic";

/**
 * Month-end billing report. Reads the PricingLog ledger (one row per
 * created task / chain child; umbrellas excluded) and groups it by
 * company × month with subtotals + a grand total + CSV export — the
 * "what do I invoice each client this month" view. The rate card is
 * the inputs (/admin/pricing); this is the accumulated charges.
 *
 * Rows are enriched (task name / brief / worker) by joining the task
 * via taskId, same as /admin/time. The price is editable per-entry:
 * the edit writes a `billed` override on the ledger row only — the
 * recorded `price`, the task, and the rate card are untouched.
 */
export default async function BillingAdminPage() {
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
    readPricingLog(adminEmail).catch(() => [] as PricingLogRow[]),
    tasksList()
      .then((r) => r.tasks ?? [])
      .catch(() => []),
  ]);

  const taskById = new Map(taskRows.map((t) => [t.id, t]));
  const workerOf = (emails: string[] | undefined): string =>
    (emails || []).map((e) => e.split("@")[0]).join(", ");

  const rows: PricingLogRow[] = ledger.map((r) => {
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

  return (
    <main className="container">
      <header className="page-header">
        <div>
          <h1>
            <span className="emoji" aria-hidden>🧾</span>
            חיובים ללקוח
          </h1>
          <div className="subtitle">
            <Link href="/admin">→ ניהול</Link> ·{" "}
            <Link href="/admin/pricing">💰 מחירון</Link> ·{" "}
            <Link href="/admin/time">⏱️ מעקב זמן</Link> · כל החיובים
            שנצברו מ-<code>PricingLog</code> — שורה לכל משימה (וכל שלב
            בשרשרת; עטיפות לא נספרות). אפשר לערוך סכום לחיוב ולהוסיף
            הערה לכל שורה (גובר/נוסף על המחיר הרשום, בלי לשנות את המחיר
            או את המחירון). סינון מתקדם (חודש, חברה, עובד, מחלקה, סוג,
            טווח תאריכים, חיפוש), סיכום ופילוחים, וייצוא CSV.
          </div>
        </div>
      </header>

      <BillingReport rows={rows} />
    </main>
  );
}
