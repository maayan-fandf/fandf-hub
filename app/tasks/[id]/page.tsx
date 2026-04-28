import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import {
  getMyProjects,
  getProjectAdLinks,
  tasksGet,
  tasksList,
  tasksPeopleList,
} from "@/lib/appsScript";
import type { WorkTask } from "@/lib/appsScript";
import { getSharedDriveName } from "@/lib/driveFolders";
import TaskStatusCell from "@/components/TaskStatusCell";
import TaskEditPanel from "@/components/TaskEditPanel";
import TaskComments from "@/components/TaskComments";
import TaskDriveComments from "@/components/TaskDriveComments";
import TaskAttachments from "@/components/TaskAttachments";
import TaskDetailTabs from "@/components/TaskDetailTabs";
import IdCopyRow from "@/components/IdCopyRow";
import CopyTaskLinkButton from "@/components/CopyTaskLinkButton";
import CopyLocalPathButton from "@/components/CopyLocalPathButton";
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
  // The access lookup runs alongside so we can bounce clients out
  // before rendering any task UI.
  const [res, peopleRes, accessRes] = await Promise.all([
    tasksGet(decodedId).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.toLowerCase().includes("not found")) return null;
      throw e;
    }),
    editing ? tasksPeopleList().catch(() => ({ ok: false, people: [] })) : null,
    getMyProjects().catch(() => null),
  ]);
  if (accessRes) {
    const isClientUser =
      !!accessRes.isClient &&
      !accessRes.isAdmin &&
      !accessRes.isStaff &&
      !accessRes.isInternal;
    if (isClientUser) redirect("/");
  }
  if (!res) notFound();

  const t = res.task;

  // Round chain: only fetch project tasks when the current task is part
  // of a multi-round chain (round_number > 1 OR has descendants —
  // checking the latter requires the fetch, so we only run it when
  // round_number > 1 since that's the more common case where siblings
  // matter). The fetch hits the same Comments tab tasksGet just read
  // from; readCommentsTab is now per-request cached so this is
  // effectively free.
  //
  // Also: shared-drive display name — used to build the Drive Desktop
  // local path for the "copy path" button (mirrors the pattern used by
  // /tasks and /projects/[name]).
  const session = await auth();
  const subjectEmail = session?.user?.email ?? "";
  // Internal-or-admin gate for the ad-platform buttons. Clients shouldn't
  // see ad-platform deep-links; for staff who aren't internal-domain we
  // still skip the buttons (they don't have @fandf.co.il Google sessions
  // that the authuser= hint helps anyway).
  const showAdLinks = !!accessRes && (accessRes.isAdmin || accessRes.isInternal);
  const [roundChain, driveName, adLinks] = await Promise.all([
    t.round_number > 1 || t.parent_id
      ? fetchRoundChain(t).catch(() => [])
      : Promise.resolve([]),
    subjectEmail
      ? getSharedDriveName(subjectEmail).catch(() => "")
      : Promise.resolve(""),
    showAdLinks && t.project
      ? getProjectAdLinks(t.project).catch(() => null)
      : Promise.resolve(null),
  ]);
  const localPath =
    driveName && t.project
      ? `G:\\Shared drives\\${driveName}\\${t.company || ""}\\${t.project}${
          t.campaign ? `\\${t.campaign}` : ""
        }`
      : "";

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
            {/* Tiny 🔗 button to copy the canonical task URL. Sits to
                the visual-left of the title (start of line in RTL is
                right, so this is at the END of the title row). */}
            <CopyTaskLinkButton />
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
        <div className="header-actions">
          {adLinks?.gAdsUrl && (
            <a
              href={adLinks.gAdsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-ghost btn-sm"
              title={
                adLinks.gAdsAcctName
                  ? `Google Ads — ${adLinks.gAdsAcctName}` +
                    (adLinks.adCampaignPatterns.length
                      ? `\nתבניות קמפיין: ${adLinks.adCampaignPatterns.join(", ")}`
                      : "")
                  : "פתח ב-Google Ads"
              }
            >
              🔍 Google Ads
            </a>
          )}
          {adLinks?.fbAdsUrl && (
            <a
              href={adLinks.fbAdsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-ghost btn-sm"
              title={
                adLinks.fbAcctName
                  ? `Facebook Ads — ${adLinks.fbAcctName}` +
                    (adLinks.adCampaignPatterns.length
                      ? `\nתבניות קמפיין: ${adLinks.adCampaignPatterns.join(", ")}`
                      : "")
                  : "פתח ב-Facebook Ads"
              }
            >
              📘 Facebook Ads
            </a>
          )}
          {t.drive_folder_url && (
            <a
              href={t.drive_folder_url}
              target="_blank"
              rel="noreferrer"
              className="btn-ghost btn-sm btn-with-drive-icon"
            >
              <GoogleDriveIcon size="1.05em" /> תיקיית קבצים
            </a>
          )}
          {localPath && (
            <CopyLocalPathButton
              path={localPath}
              title="העתק נתיב מקומי — Drive Desktop"
            />
          )}
          {!editing && (
            <Link
              href={`/tasks/${encodeURIComponent(t.id)}?edit=1`}
              className="btn-ghost btn-sm"
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
            <TaskAttachments
              taskId={t.id}
              taskTitle={t.title}
              driveFolderId={t.drive_folder_id}
              driveFolderUrl={t.drive_folder_url}
            />
            {t.drive_folder_id && (
              <TaskDriveComments
                taskId={t.id}
                driveFolderId={t.drive_folder_id}
                driveFolderUrl={t.drive_folder_url}
              />
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
            <RoundRow task={t} chain={roundChain} />
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

/**
 * Walks the parent_id chain rooted at `t` and returns every task in
 * the round-chain (root + all descendants), sorted by round_number.
 *
 * `parent_id` semantics aren't strictly defined by the schema — it
 * could in principle point to either the immediate predecessor or
 * the chain root. To handle both we walk UP from `t` (following
 * parent_id until we hit "" or a missing id) to find the root, then
 * fan DOWN from the root via BFS.
 *
 * Falls back to an empty list on any fetch error so the side panel
 * still renders cleanly.
 */
async function fetchRoundChain(t: WorkTask): Promise<WorkTask[]> {
  if (!t.project) return [];
  const list = await tasksList({ project: t.project });
  const allTasks = list.tasks;
  if (allTasks.length === 0) return [];
  const byId = new Map(allTasks.map((x) => [x.id, x]));

  // Walk UP to root.
  let root: WorkTask = byId.get(t.id) ?? t;
  let safety = 20;
  while (root.parent_id && safety-- > 0) {
    const next = byId.get(root.parent_id);
    if (!next || next.id === root.id) break;
    root = next;
  }

  // Fan DOWN from root via BFS.
  const visited = new Set<string>([root.id]);
  const chain: WorkTask[] = [root];
  const queue: string[] = [root.id];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const x of allTasks) {
      if (x.parent_id === id && !visited.has(x.id)) {
        visited.add(x.id);
        chain.push(x);
        queue.push(x.id);
      }
    }
  }

  return chain.sort(
    (a, b) => (a.round_number || 0) - (b.round_number || 0),
  );
}

/**
 * Side-panel "סבב" row. Three render modes:
 *   1. Single-round task with no descendants → "ראשון"
 *   2. Multi-round task (has parent_id or chain length > 1) → current
 *      round number + a clickable list of every round in the chain,
 *      with the current task styled as inert.
 *   3. Round 1 task that HAS descendants (chain.length > 1) → same as
 *      mode 2 (chain list, current is the root).
 */
function RoundRow({
  task,
  chain,
}: {
  task: WorkTask;
  chain: WorkTask[];
}) {
  if (chain.length <= 1 && task.round_number <= 1) {
    return <KV label="סבב" value="ראשון" />;
  }
  return (
    <div className="task-kv">
      <dt>סבב</dt>
      <dd>
        <div className="task-round-current">#{task.round_number || "?"}</div>
        {chain.length > 1 && (
          <div className="task-round-chain">
            <span className="task-round-chain-label">שרשור:</span>
            {chain.map((c) => {
              const isCurrent = c.id === task.id;
              if (isCurrent) {
                return (
                  <span
                    key={c.id}
                    className="task-round-link is-current"
                    title={c.title || c.id}
                    aria-current="true"
                  >
                    #{c.round_number || "?"}
                  </span>
                );
              }
              return (
                <Link
                  key={c.id}
                  href={`/tasks/${encodeURIComponent(c.id)}`}
                  className="task-round-link"
                  title={c.title || c.id}
                >
                  #{c.round_number || "?"}
                </Link>
              );
            })}
          </div>
        )}
      </dd>
    </div>
  );
}
