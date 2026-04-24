import Link from "next/link";
import { notFound } from "next/navigation";
import { tasksGet, tasksPeopleList } from "@/lib/appsScript";
import TaskStatusActions from "@/components/TaskStatusActions";
import TaskEditPanel from "@/components/TaskEditPanel";
import TaskComments from "@/components/TaskComments";

export const dynamic = "force-dynamic";

const STATUS_LABELS: Record<string, string> = {
  draft: "טיוטה",
  awaiting_handling: "ממתין לטיפול",
  in_progress: "בעבודה",
  awaiting_clarification: "ממתין לבירור",
  awaiting_approval: "ממתין לאישור",
  done: "בוצע",
  cancelled: "בוטל",
};

export default async function TaskDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ edit?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const decodedId = decodeURIComponent(id);
  const editing = sp.edit === "1";

  // When we're entering edit mode we need the people list for the
  // autocomplete datalist + chip picker. Parallel fetch — the people
  // call is cheap enough (~60 entries across the whole portfolio).
  const [res, peopleRes] = await Promise.all([
    tasksGet(decodedId).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.toLowerCase().includes("not found")) return null;
      throw e;
    }),
    editing ? tasksPeopleList().catch(() => ({ ok: false, people: [] })) : null,
  ]);
  if (!res) notFound();

  const t = res.task;
  const statusLabel = STATUS_LABELS[t.status] || t.status;

  return (
    <main className="container">
      <header className="page-header">
        <div>
          <div className="task-detail-crumbs">
            <Link href="/tasks">← משימות</Link>
            {" · "}
            {t.company && (
              <>
                <Link href={`/tasks?company=${encodeURIComponent(t.company)}`}>
                  {t.company}
                </Link>
                {" / "}
              </>
            )}
            <Link href={`/projects/${encodeURIComponent(t.project)}`}>
              {t.project}
            </Link>
            {t.brief && <> {" · "} בריף #{t.brief}</>}
          </div>
          <h1 className="task-detail-title">{t.title}</h1>
          <div className="subtitle">
            <span className={`tasks-status-pill tasks-status-${t.status}`}>
              {statusLabel}
            </span>
            {t.sub_status && (
              <>
                {" "}
                <span className="tasks-substatus-pill">{t.sub_status}</span>
              </>
            )}{" "}
            · עדיפות {t.priority} ·{" "}
            {(t.departments || []).join(", ") || "—"}{" "}
            {t.requested_date ? `· מבוקש: ${t.requested_date}` : ""}
            {t.round_number > 1 && (
              <>
                {" "}
                · <span className="tasks-round-chip">סבב #{t.round_number}</span>
              </>
            )}
          </div>
        </div>
        <div className="page-header-actions">
          {t.drive_folder_url && (
            <a
              href={t.drive_folder_url}
              target="_blank"
              rel="noreferrer"
              className="btn-ghost"
            >
              📁 תיקיית קבצים
            </a>
          )}
          {!editing && (
            <Link
              href={`/tasks/${encodeURIComponent(t.id)}?edit=1`}
              className="btn-ghost"
            >
              ✏️ ערוך
            </Link>
          )}
        </div>
      </header>

      {editing && (
        <TaskEditPanel task={t} people={peopleRes?.people ?? []} />
      )}

      <section className="task-detail-grid">
        <div className="task-detail-main">
          {t.description && (
            <div className="task-detail-body">
              {t.description.split("\n").map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
          )}

          {!editing && <TaskStatusActions task={t} />}

          <section className="task-detail-history">
            <h3>היסטוריית סטטוסים</h3>
            <ul>
              {(t.status_history || []).map((h, i) => (
                <li key={i}>
                  <time>{h.at.slice(0, 16).replace("T", " ")}</time>
                  {" · "}
                  {shortName(h.by)} — {h.from || "—"} → <b>{STATUS_LABELS[h.to] || h.to}</b>
                  {h.note ? ` · ${h.note}` : ""}
                </li>
              ))}
            </ul>
          </section>

          <TaskComments taskId={t.id} />
        </div>

        <aside className="task-detail-side">
          <KV label="חברה" value={t.company || "—"} />
          <KV label="פרויקט" value={t.project} />
          <KV label="קמפיין" value={t.campaign || "—"} />
          <KV label="בריף" value={t.brief || "—"} />
          <KV label="כותב" value={shortName(t.author_email)} />
          <KV label="גורם מאשר" value={shortName(t.approver_email)} />
          <KV label="מנהל פרויקט" value={shortName(t.project_manager_email)} />
          <KV
            label="עובדים במשימה"
            value={(t.assignees || []).map(shortName).join(", ") || "—"}
          />
          <KV label="סוג" value={t.kind} />
          <KV label="מחלקות" value={(t.departments || []).join(", ") || "—"} />
          <KV
            label="סבב"
            value={
              t.round_number && t.round_number > 1
                ? `#${t.round_number}${t.parent_id ? ` (נולד מ־${t.parent_id})` : ""}`
                : "ראשון"
            }
          />
          <KV label="נוצר" value={t.created_at.slice(0, 16).replace("T", " ")} />
          <KV label="עודכן" value={t.updated_at.slice(0, 16).replace("T", " ")} />
          <KV label="id" value={t.id} />
        </aside>
      </section>
    </main>
  );
}

function shortName(email: string): string {
  if (!email) return "";
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="task-kv">
      <dt>{label}</dt>
      <dd>{value || "—"}</dd>
    </div>
  );
}
