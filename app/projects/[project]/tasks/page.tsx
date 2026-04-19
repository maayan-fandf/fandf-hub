import Link from "next/link";
import { getProjectTasks, type TaskItem } from "@/lib/appsScript";
import Board from "@/components/Board";
import FilterBar from "@/components/FilterBar";
import CreateTaskDrawer from "@/components/CreateTaskDrawer";

export const dynamic = "force-dynamic";

type Params = { project: string };
type Search = { done?: string; assignee?: string };

export default async function TaskBoardPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Search>;
}) {
  const { project: projectParam } = await params;
  const projectName = decodeURIComponent(projectParam);
  const sp = await searchParams;
  const showDone = sp.done === "1";
  const assigneeFilter = sp.assignee ?? "";

  let data;
  let error: string | null = null;
  try {
    data = await getProjectTasks(projectName);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return (
    <main className="container">
      <header className="page-header">
        <div>
          <h1>
            <span className="emoji" aria-hidden>📋</span>
            {projectName} · משימות
          </h1>
          <div className="subtitle">
            <Link href={`/projects/${encodeURIComponent(projectName)}`}>
              → סקירת {projectName}
            </Link>
            {data && ` · 🔥 ${countOpen(data.tasks)} פתוחות`}
          </div>
        </div>
        <CreateTaskDrawer project={projectName} />
      </header>

      {error && (
        <div className="error">
          <strong>שגיאה בטעינת המשימות.</strong>
          <br />
          {error}
        </div>
      )}

      {data && data.tasks.length === 0 && (
        <div className="empty">
          <span className="emoji" aria-hidden>🎯</span>
          עדיין אין משימות. משימות נוצרות כאשר מתייגים משתמש פנימי בהערה בדשבורד,
          או מכאן באמצעות כפתור &quot;+ משימה חדשה&quot;.
        </div>
      )}

      {data && data.tasks.length > 0 && (
        <>
          <FilterBar
            assignees={assigneeSummary(data.tasks)}
            currentAssignee={assigneeFilter}
            showDone={showDone}
          />
          <Board
            tasks={data.tasks}
            today={data.today}
            assigneeFilter={assigneeFilter}
            showDone={showDone}
          />
        </>
      )}
    </main>
  );
}

function countOpen(tasks: TaskItem[]): number {
  return tasks.filter((t) => !t.resolved).length;
}

function assigneeSummary(
  tasks: TaskItem[],
): { email: string; name: string; openCount: number }[] {
  const map = new Map<string, { email: string; name: string; openCount: number }>();
  for (const t of tasks) {
    const key = t.assignee_email;
    if (!map.has(key)) {
      map.set(key, { email: key, name: t.assignee_name || key.split("@")[0], openCount: 0 });
    }
    if (!t.resolved) map.get(key)!.openCount++;
  }
  return Array.from(map.values()).sort((a, b) => b.openCount - a.openCount);
}
