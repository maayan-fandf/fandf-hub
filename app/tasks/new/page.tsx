import Link from "next/link";
import { getMyProjects } from "@/lib/appsScript";
import TaskCreateForm from "@/components/TaskCreateForm";

export const dynamic = "force-dynamic";

type Search = { project?: string };

export default async function NewTaskPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const projectsRes = await getMyProjects().catch(() => null);
  const projects = (projectsRes?.projects ?? []).map((p) => p.name).sort();

  return (
    <main className="container">
      <header className="page-header">
        <div>
          <h1>
            <span className="emoji" aria-hidden>
              ➕
            </span>
            משימה חדשה
          </h1>
          <div className="subtitle">
            ברירת המחדל — יוצר משימה עם סטטוס &quot;ממתין לאישור&quot;. בעת יצירה
            המערכת פותחת תיקייה ב־Drive, שולחת מייל לגורם המאשר, ומוסיפה אירוע
            ב־Google Calendar + משימה ב־Google Tasks לכל מבצע.
          </div>
        </div>
        <div className="page-header-actions">
          <Link href="/tasks" className="btn-ghost">
            ← חזרה לרשימה
          </Link>
        </div>
      </header>

      <TaskCreateForm projects={projects} defaultProject={sp.project || ""} />
    </main>
  );
}
