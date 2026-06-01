import Link from "next/link";
import { redirect } from "next/navigation";
import { getMyProjects, currentUserEmail } from "@/lib/appsScript";
import { getTaskFormSchema } from "@/lib/taskFormSchema";
import TaskFormSchemaViewer from "@/components/TaskFormSchemaEditor";

export const metadata = { title: "סכמת טופס משימה" };

export const dynamic = "force-dynamic";

export default async function TaskFormSchemaAdminPage() {
  let isAdmin = false;
  try {
    const me = await getMyProjects();
    isAdmin = me.isAdmin;
  } catch {
    isAdmin = false;
  }
  if (!isAdmin) redirect("/");

  const adminEmail = await currentUserEmail();
  const schema = await getTaskFormSchema(adminEmail).catch(() => ({
    departments: [] as string[],
    allKinds: [] as string[],
    kindsByDepartment: {} as Record<string, string[]>,
    templatesByDeptAndKind: {} as Record<string, Record<string, string>>,
    isEmpty: true,
  }));

  return (
    <main className="container">
      <header className="page-header">
        <div>
          <h1>
            <span className="emoji" aria-hidden>📐</span>
            סכמת טופס משימה
          </h1>
          <div className="subtitle">
            <Link href="/admin">→ ניהול</Link> ·{" "}
            <Link href="/admin/pricing">💰 תמחור</Link> (מחירון לפי
            חברה/פרוייקט × מחלקה × סוג) · שולט על המחלקות והסוגים
            הזמינים בטופס &quot;משימה חדשה&quot;. כל סוג הוא תיקייה ב-Drive
            תחת <code>סכמות משימה/&lt;מחלקה&gt;/&lt;סוג&gt;/</code>. כשמוסיפים
            תיקייה כאן (או ישירות ב-Drive), היא נכנסת לתוקף תוך כ-5 דקות
            (ניתן לרענן ידנית).
          </div>
        </div>
      </header>

      <TaskFormSchemaViewer schema={schema} />
    </main>
  );
}
