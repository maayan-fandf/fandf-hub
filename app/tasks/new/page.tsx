import Link from "next/link";
import {
  getMyProjects,
  tasksPeopleList,
  currentUserEmail,
} from "@/lib/appsScript";
import TaskCreateForm from "@/components/TaskCreateForm";

export const dynamic = "force-dynamic";

type Search = { project?: string; company?: string };

export default async function NewTaskPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  // Three independent fetches, all server-side so the form renders with
  // everything pre-populated (no loading spinners for dropdowns).
  const [projectsRes, peopleRes, me] = await Promise.all([
    getMyProjects().catch(() => null),
    tasksPeopleList().catch(() => ({ ok: false, people: [] })),
    currentUserEmail().catch(() => ""),
  ]);

  // Build a lean project list with the roster field we actually auto-fill
  // (account manager = Keys col D "EMAIL Manager", stored as a Hebrew full
  // name like "Itay Stein"). The form resolves the name → email against
  // the `people` list client-side.
  const projects = (projectsRes?.projects ?? []).map((p) => ({
    name: p.name,
    company: p.company,
    projectManagerFull: p.roster?.projectManagerFull || "",
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

      <TaskCreateForm
        projects={projects}
        defaultProject={sp.project || ""}
        people={peopleRes?.people ?? []}
        currentUserEmail={me}
      />
    </main>
  );
}
