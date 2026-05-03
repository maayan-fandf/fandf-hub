import Link from "next/link";
import { redirect } from "next/navigation";
import { getMyProjects } from "@/lib/appsScript";

export const dynamic = "force-dynamic";

/**
 * Admin landing page. Server component — checks admin status by re-using
 * getMyProjects() (it already returns isAdmin) so we don't need a dedicated
 * /api/me endpoint. Non-admins are bounced to the home page.
 *
 * As we build more admin sections they get added to the `sections` array.
 */
export default async function AdminHome() {
  let isAdmin = false;
  try {
    const me = await getMyProjects();
    isAdmin = me.isAdmin;
  } catch {
    // If the auth call itself fails, don't pretend to be admin.
    isAdmin = false;
  }
  if (!isAdmin) redirect("/");

  const sections: {
    href: string;
    title: string;
    emoji: string;
    subtitle: string;
    ready: boolean;
  }[] = [
    {
      href: "/admin/names-to-emails",
      title: "שמות ואימיילים",
      emoji: "📇",
      subtitle:
        "הגדרת מיפוי שמות לאימיילים — מקור הנתונים ללוח התיוגים והרשאות הצוות.",
      ready: true,
    },
    {
      href: "/admin/chat-spaces",
      title: "Chat Spaces",
      emoji: "💬",
      subtitle:
        "הקמה אוטומטית של Space ב־Google Chat לכל פרויקט — צוות + לקוחות במקום אחד, עם Tasks + Files משותפים.",
      ready: true,
    },
    {
      href: "/admin/chain-templates",
      title: "תבניות שרשרת",
      emoji: "📦",
      subtitle:
        "תבניות מוכנות ליצירת שרשרת משימות (״עדכון ויזואל״, ״השקת קמפיין״ ועוד). מגדיר לכל שלב את המחלקה שמתוכה אפשר לשבץ מבצע.",
      ready: true,
    },
    {
      href: "/admin/projects",
      title: "פרויקטים",
      emoji: "🏢",
      subtitle: "עריכת Keys — פרויקטים, חברה, צוות פנימי וחיצוני.",
      ready: false,
    },
    {
      href: "/admin/admins",
      title: "אדמינים",
      emoji: "👑",
      subtitle: "ניהול רשימת אדמינים.",
      ready: false,
    },
    {
      href: "/admin/webhooks",
      title: "Webhooks",
      emoji: "🔗",
      subtitle: "טאב Webhooks — URLs לכל לקוח חיצוני.",
      ready: false,
    },
  ];

  return (
    <main className="container">
      <header className="page-header">
        <div>
          <h1>
            <span className="emoji" aria-hidden>⚙️</span>
            ניהול
          </h1>
          <div className="subtitle">אזור אדמין — עריכת תצורה של המערכת.</div>
        </div>
      </header>

      <ul className="admin-section-list">
        {sections.map((s) =>
          s.ready ? (
            <li key={s.href} className="admin-section-card">
              <Link href={s.href}>
                <div className="admin-section-title">
                  <span aria-hidden>{s.emoji}</span>
                  {s.title}
                </div>
                <div className="admin-section-sub">{s.subtitle}</div>
              </Link>
            </li>
          ) : (
            <li
              key={s.href}
              className="admin-section-card is-disabled"
              title="בקרוב"
            >
              <div className="admin-section-title">
                <span aria-hidden>{s.emoji}</span>
                {s.title}
                <span className="chip chip-muted">בקרוב</span>
              </div>
              <div className="admin-section-sub">{s.subtitle}</div>
            </li>
          ),
        )}
      </ul>
    </main>
  );
}
