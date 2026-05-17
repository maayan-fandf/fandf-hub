import Link from "next/link";
import { redirect } from "next/navigation";
import { getMyProjects, currentUserEmail } from "@/lib/appsScript";
import { readTimeLog } from "@/lib/timeLog";
import TimeReport from "@/components/TimeReport";

export const dynamic = "force-dynamic";

/**
 * Time-tracking report. Reads the TimeLog ledger (one row per logged
 * time entry, per person per task) and groups it by company × month
 * with sub-totals + a grand total + CSV export — the "how much time
 * went into each client this month" view. Informational only: time
 * does NOT drive a charge; client invoicing stays on the flat
 * Pricingsetup price (/admin/billing).
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
  const rows = await readTimeLog(adminEmail).catch(() => []);

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
            <Link href="/admin/billing">🧾 חיובים ללקוח</Link> · כל הזמן
            שתועד מ-<code>TimeLog</code> — שורה לכל תיעוד (לכל אדם, לכל
            משימה). סינון לפי חודש + חברה, סכום זמן, וייצוא CSV. הזמן הוא
            מידע בלבד — אינו משפיע על החיוב ללקוח.
          </div>
        </div>
      </header>

      <TimeReport rows={rows} />
    </main>
  );
}
