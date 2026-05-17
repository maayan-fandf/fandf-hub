import Link from "next/link";
import { redirect } from "next/navigation";
import { getMyProjects, currentUserEmail } from "@/lib/appsScript";
import { readPricingLog } from "@/lib/pricingLog";
import BillingReport from "@/components/BillingReport";

export const dynamic = "force-dynamic";

/**
 * Month-end billing report. Reads the PricingLog ledger (one row per
 * created task / chain child; umbrellas excluded) and groups it by
 * company × month with subtotals + a grand total + CSV export — the
 * "what do I invoice each client this month" view. The rate card is
 * the inputs (/admin/pricing); this is the accumulated charges.
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
  const rows = await readPricingLog(adminEmail).catch(() => []);

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
            <Link href="/admin/pricing">💰 מחירון</Link> · כל החיובים
            שנצברו מ-<code>PricingLog</code> — שורה לכל משימה (וכל שלב
            בשרשרת; עטיפות לא נספרות). סינון לפי חודש + חברה, סכום
            לחיוב, וייצוא CSV לחשבונאות.
          </div>
        </div>
      </header>

      <BillingReport rows={rows} />
    </main>
  );
}
