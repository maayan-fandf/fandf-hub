import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getMyProjects,
  currentUserEmail,
} from "@/lib/appsScript";
import { listTaskFormSchemaRows } from "@/lib/taskFormSchema";
import TaskFormSchemaEditor from "@/components/TaskFormSchemaEditor";

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
  const initialRows = await listTaskFormSchemaRows(adminEmail).catch(() => []);

  return (
    <main className="container">
      <header className="page-header">
        <div>
          <h1>
            <span className="emoji" aria-hidden>📐</span>
            סכמת טופס משימה
          </h1>
          <div className="subtitle">
            <Link href="/admin">→ ניהול</Link> · שולט על המחלקות והסוגים
            הזמינים בטופס &quot;משימה חדשה&quot;. כל סוג משויך למחלקה — בעת
            יצירת משימה, לאחר בחירת מחלקה הסוגים מסוננים אוטומטית. שינויים
            כאן או ישירות ב-Google Sheets (לשונית <code>TaskFormSchema</code>)
            נכנסים לתוקף תוך כ-5 דקות.
          </div>
        </div>
      </header>

      <TaskFormSchemaEditor initialRows={initialRows} />
    </main>
  );
}
