import Link from "next/link";
import { redirect } from "next/navigation";
import { getMyProjects } from "@/lib/appsScript";
import ChatSpacesList from "@/components/ChatSpacesList";

export const dynamic = "force-dynamic";

export default async function ChatSpacesAdminPage() {
  const me = await getMyProjects().catch(() => null);
  if (!me?.isAdmin) redirect("/");

  // Group projects by company so the onboarding flow visually mirrors
  // how the Keys sheet is laid out. Empty company tasks sink to the
  // bottom under "(ללא חברה)".
  const byCompany = new Map<string, typeof me.projects>();
  for (const p of me.projects) {
    const co = p.company || "";
    if (!byCompany.has(co)) byCompany.set(co, []);
    byCompany.get(co)!.push(p);
  }
  const companies = Array.from(byCompany.entries()).sort(([a], [b]) => {
    if (!a && b) return 1;
    if (a && !b) return -1;
    return a.localeCompare(b);
  });

  return (
    <main className="container">
      <header className="page-header">
        <div>
          <div className="task-detail-crumbs">
            <Link href="/admin">← ניהול</Link>
          </div>
          <h1>
            <span className="emoji" aria-hidden>
              💬
            </span>
            Chat Spaces
          </h1>
          <div className="subtitle">
            הקמת Space ב־Google Chat לכל פרויקט, באופן אוטומטי. כל Space
            משלב תיבת צ׳אט דו־כיוונית, Tasks משותפים, וקבצים מ־Drive
            במקום אחד — גם לקוחות חיצוניים ב־Gmail (לא Workspace) יכולים
            להצטרף.
          </div>
        </div>
      </header>

      <div className="chat-spaces-notice">
        <h3>לפני ההפעלה</h3>
        <ol>
          <li>
            <b>Apps Script editor</b> → Services → Add service → בחר{" "}
            <code>Google Chat API</code> → Add.
          </li>
          <li>
            <b>GCP Console</b> (באותו project) → APIs &amp; Services →
            Library → חפש &quot;Google Chat API&quot; → Enable.
          </li>
          <li>
            <b>Workspace Admin</b> → Apps → Google Chat → App settings →
            וודא ש־External groups enabled פעיל (כדי שלקוחות חיצוניים
            יוכלו להצטרף).
          </li>
        </ol>
        <p className="muted">
          עד שהשלבים הללו הושלמו הכפתור &quot;צור Space&quot; יחזיר שגיאה
          מסוג <code>Chat API not enabled</code> — נבלעת בצד הלקוח ומוצגת
          בהודעת השגיאה מול הפרויקט.
        </p>
      </div>

      <ChatSpacesList companies={companies} />
    </main>
  );
}
