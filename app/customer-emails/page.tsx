import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getEffectiveViewAs } from "@/lib/viewAsCookie";
import { getUserPrefs } from "@/lib/userPrefs";
import {
  listCustomerEmails,
  type CustomerEmailItem,
} from "@/lib/customerEmails";
import CustomerEmailsList from "@/components/CustomerEmailsList";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Customer-email triage page. Lists unread Gmail messages from senders
 * registered in Keys col E ('Email Client'), received in the last 3
 * days. Per-render Gmail call (no cron, no cache) because the source
 * of truth is Gmail itself and `is:unread` makes "dismissed" implicit.
 *
 * Gated by `gmail_customer_poll` user pref. Default off — the cron-
 * style impersonation reads inbox content for matching senders, which
 * is a meaningfully different trust posture than the manual "Add to
 * Tasks" flow. When the toggle is off we render an empty-state with
 * directions instead of silently 404-ing.
 */
export default async function CustomerEmailsPage() {
  const session = await auth();
  const sessionEmail = session?.user?.email;
  if (!sessionEmail) {
    redirect("/");
  }

  const viewAs = await getEffectiveViewAs(sessionEmail).catch(() => "");
  const targetEmail = viewAs || sessionEmail;

  const prefs = await getUserPrefs(targetEmail);

  if (!prefs.gmail_customer_poll) {
    return (
      <main className="page customer-emails-page">
        <header className="customer-emails-head">
          <h1>📬 מיילים מלקוחות</h1>
        </header>
        <div className="customer-emails-empty">
          <p>הפיצ׳ר כבוי כברירת מחדל.</p>
          <p>
            כדי להפעיל, פתח את תפריט ⚙️ והדלק את &ldquo;מיילים מלקוחות&rdquo;.
            לאחר ההפעלה הדף יציג מיילים חדשים מלקוחות הרשומים בעמודה{" "}
            <b>Email Client</b> (col E) בגיליון Keys, מ-3 הימים האחרונים.
          </p>
        </div>
      </main>
    );
  }

  let items: CustomerEmailItem[] = [];
  let error = "";
  try {
    items = await listCustomerEmails(targetEmail);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <main className="page customer-emails-page">
      <header className="customer-emails-head">
        <h1>📬 מיילים מלקוחות</h1>
        <p className="customer-emails-sub">
          מיילים לא נקראו מלקוחות רשומים, מ-3 הימים האחרונים. לסגירת פריט
          — קרא או העבר לארכיון ב-Gmail.
        </p>
      </header>
      <CustomerEmailsList items={items} error={error} />
    </main>
  );
}
