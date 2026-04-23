import Link from "next/link";
import { getMyProjects } from "@/lib/appsScript";
import TaskCreateForm from "@/components/TaskCreateForm";

export const dynamic = "force-dynamic";

type Search = { project?: string; company?: string };

export default async function NewTaskPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const projectsRes = await getMyProjects().catch(() => null);
  const projects = (projectsRes?.projects ?? []).map((p) => ({
    name: p.name,
    company: p.company,
  }));

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
            ברירת המחדל — &quot;ממתין לאישור&quot;. בעת יצירה: תיקייה ב־Drive
            תחת <code dir="ltr">חברה / פרויקט / משימה</code>, מייל לגורם המאשר,
            אירוע ב־Google Calendar + משימה ב־Google Tasks לכל מבצע.
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
