import Link from "next/link";
import { notFound } from "next/navigation";
import { tasksGet, tasksPeopleList } from "@/lib/appsScript";
import TaskStatusCell from "@/components/TaskStatusCell";
import TaskEditPanel from "@/components/TaskEditPanel";
import TaskComments from "@/components/TaskComments";
import TaskDriveComments from "@/components/TaskDriveComments";
import TaskDetailTabs from "@/components/TaskDetailTabs";
import IdCopyRow from "@/components/IdCopyRow";
import TaskStatusHistory from "@/components/TaskStatusHistory";
import GoogleDriveIcon from "@/components/GoogleDriveIcon";
import Avatar from "@/components/Avatar";

export const dynamic = "force-dynamic";

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
          <div className="task-detail-title-row">
            <h1 className="task-detail-title">{t.title}</h1>
            {/* Inline status cell — same component the kanban + queue
                use, so this header doubles as the action surface. The
                separate TaskStatusActions panel that used to sit below
                is gone (redundant once the pill is interactive). */}
            <TaskStatusCell task={t} />
          </div>
          <div className="subtitle task-detail-meta">
            <span className={`tasks-priority-pill p${t.priority}`} title="דחיפות">
              {t.priority === 1 ? "🔥 גבוהה" : t.priority === 3 ? "⏬ נמוכה" : "רגילה"}
            </span>
            {(t.departments || []).map((d) => (
              <span key={d} className="tasks-dept-chip" title="מחלקה">
                🏷️ {d}
              </span>
            ))}
            {t.requested_date && (
              <span className="task-meta-date" title="תאריך מבוקש">
                📅 {t.requested_date.replace("T", " ")}
              </span>
            )}
            {t.round_number > 1 && (
              <span className="tasks-round-chip">סבב #{t.round_number}</span>
            )}
          </div>
        </div>
        <div className="page-header-actions">
          {t.drive_folder_url && (
            <a
              href={t.drive_folder_url}
              target="_blank"
              rel="noreferrer"
              className="btn-ghost btn-with-drive-icon"
            >
              <GoogleDriveIcon size="1.05em" /> תיקיית קבצים
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

          {/* Sticky in-page tab strip — anchor-jumps to the three
              sub-sections below + highlights the section the reader is
              currently looking at. Sections are rendered in tab order
              (דיון → היסטוריה → קבצים) so DOM order matches navigation. */}
          <TaskDetailTabs />

          <section
            id="task-discussion"
            className="task-detail-section task-detail-section-discussion"
          >
            <TaskComments taskId={t.id} />
          </section>

          <section
            id="task-history"
            className="task-detail-section task-detail-history"
          >
            <h3>היסטוריית סטטוסים</h3>
            <TaskStatusHistory history={t.status_history || []} />
          </section>

          <section
            id="task-files"
            className="task-detail-section task-detail-section-files"
          >
            {t.drive_folder_id ? (
              <TaskDriveComments
                taskId={t.id}
                driveFolderId={t.drive_folder_id}
                driveFolderUrl={t.drive_folder_url}
              />
            ) : (
              <div className="task-detail-files-empty">
                <h3>📁 קבצים</h3>
                <p className="muted">למשימה זו עוד אין תיקיית קבצים ב-Drive.</p>
              </div>
            )}
          </section>
        </div>

        <aside
          className={`task-detail-side${editing ? " is-edit-mode" : ""}`}
          aria-label="פרטי המשימה"
        >
          {/* Edit-mode banner: when ?edit=1 the form below the header
              owns the live state; the side panel still shows the
              server-side values, which look interactive but aren't.
              Greying it out + a clear banner makes the relationship
              explicit. */}
          {editing && (
            <div className="task-detail-side-banner" role="status">
              ✏️ מצב עריכה — עדכון יוצג לאחר שמירה
            </div>
          )}

          <SideBlock title="אנשים">
            <PersonRow
              label="כותב"
              email={t.author_email}
              filterKey="author"
            />
            <PersonRow
              label="גורם מאשר"
              email={t.approver_email}
              filterKey="approver"
            />
            <PersonRow
              label="מנהל פרויקט"
              email={t.project_manager_email}
              filterKey="project_manager"
            />
            <PeopleRow
              label="עובדים במשימה"
              emails={t.assignees || []}
              filterKey="assignee"
            />
          </SideBlock>

          <SideBlock title="שיוך">
            <KV label="חברה" value={t.company || "—"} />
            <KV label="פרויקט" value={t.project} />
            <KV label="קמפיין" value={t.campaign || "—"} />
            <KV label="בריף" value={t.brief || "—"} />
          </SideBlock>

          <SideBlock title="פרטים">
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
            <IdCopyRow id={t.id} />
          </SideBlock>
        </aside>
      </section>
    </main>
  );
}

/**
 * Visual grouping wrapper for the side panel. Splits the previously-
 * flat list of 14 dt/dd rows into three semantic blocks (אנשים / שיוך
 * / פרטים) so the eye doesn't have to scan a wall of equally-weighted
 * labels to find what it needs. The block heading is intentionally
 * subtle — same color as the dt labels, just a touch larger.
 */
function SideBlock({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="task-detail-side-block">
      <h3 className="task-detail-side-block-title">{title}</h3>
      <div className="task-detail-side-block-body">{children}</div>
    </section>
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

/**
 * Side-panel row for a single person field (כותב / מאשר / מנהל פרויקט).
 * Renders as an avatar chip linking back to /tasks filtered by that
 * person — clicking jumps from "this task" to "everything they own /
 * authored / are approving". Tooltip carries the full email so the
 * shortened display name is recoverable on hover.
 */
function PersonRow({
  label,
  email,
  filterKey,
}: {
  label: string;
  email: string;
  filterKey: string;
}) {
  return (
    <div className="task-kv">
      <dt>{label}</dt>
      <dd>
        {email ? (
          <PersonChip email={email} filterKey={filterKey} />
        ) : (
          <span className="task-kv-empty">—</span>
        )}
      </dd>
    </div>
  );
}

/** Multi-person variant for the assignees row. */
function PeopleRow({
  label,
  emails,
  filterKey,
}: {
  label: string;
  emails: string[];
  filterKey: string;
}) {
  return (
    <div className="task-kv">
      <dt>{label}</dt>
      <dd>
        {emails.length === 0 ? (
          <span className="task-kv-empty">—</span>
        ) : (
          <div className="task-people-row">
            {emails.map((email) => (
              <PersonChip key={email} email={email} filterKey={filterKey} />
            ))}
          </div>
        )}
      </dd>
    </div>
  );
}

function PersonChip({ email, filterKey }: { email: string; filterKey: string }) {
  return (
    <Link
      href={`/tasks?${filterKey}=${encodeURIComponent(email)}`}
      className="task-person-chip"
      title={email}
    >
      <Avatar name={email} title={email} size={22} />
      <span className="task-person-chip-name">{shortName(email)}</span>
    </Link>
  );
}
