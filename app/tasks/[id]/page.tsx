export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Look up the task title for the tab; falls back to the id if the
  // fetch fails (don't want the metadata path to crash the page render).
  try {
    const { tasksGet } = await import("@/lib/appsScript");
    const res = await tasksGet(id);
    const t = res?.task;
    if (t?.title) return { title: `משימה: ${t.title}` };
  } catch {}
  return { title: `משימה ${id.slice(0, 7)}` };
}

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import {
  currentUserEmail,
  getMyProjects,
  getProjectAdLinks,
  getTaskComments,
  tasksGet,
  tasksList,
  tasksPeopleList,
} from "@/lib/appsScript";
import { getTaskFormSchema } from "@/lib/taskFormSchema";
import { canViewAdLinks } from "@/lib/adLinkAccess";
import type { WorkTask, TasksPerson } from "@/lib/appsScript";
import { personDisplayName } from "@/lib/personDisplay";
import {
  getSharedDriveName,
  listFolderFiles,
  listFolderChildren,
  type DriveFile,
} from "@/lib/driveFolders";
import { buildLocalDrivePaths } from "@/lib/localDrivePath";
import TaskStatusCell from "@/components/TaskStatusCell";
import TaskActionPrompt from "@/components/TaskActionPrompt";
import TaskCreateForm from "@/components/TaskCreateForm";
import TaskComments from "@/components/TaskComments";
import TaskDriveComments from "@/components/TaskDriveComments";
import TaskAttachments from "@/components/TaskAttachments";
import TaskFilesPanel from "@/components/TaskFilesPanel";
import TaskApprovalConfirmBanner from "@/components/TaskApprovalConfirmBanner";
import TaskApprovalBanner from "@/components/TaskApprovalBanner";
import { displayProjectOrCompany } from "@/lib/personalLabel";
import TaskDetailTabs from "@/components/TaskDetailTabs";
import IdCopyRow from "@/components/IdCopyRow";
import CopyTaskLinkButton from "@/components/CopyTaskLinkButton";
import CopyLocalPathButton from "@/components/CopyLocalPathButton";
import TaskStatusHistory from "@/components/TaskStatusHistory";
import GoogleDriveIcon from "@/components/GoogleDriveIcon";
import FacebookAdsIcon from "@/components/FacebookAdsIcon";
import GoogleAdsIcon from "@/components/GoogleAdsIcon";
import Avatar from "@/components/Avatar";
import UmbrellaDetailMain from "@/components/UmbrellaDetailMain";
import TaskDependencyLinks from "@/components/TaskDependencyLinks";
import TaskTemplatePreview from "@/components/TaskTemplatePreview";
import TaskTimeTracker from "@/components/TaskTimeTracker";
import TaskTimePauseQuick from "@/components/TaskTimePauseQuick";
import { deriveInProgressTime } from "@/lib/inProgressTime";
import { linkifyParagraphs } from "@/lib/linkify";

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

  // We always load the people list now so read-mode chips can resolve
  // emails to Hebrew display names (sheet's `he name` column). The call
  // is cheap (~60 entries across the whole portfolio) and runs in
  // parallel with everything else. Edit-mode also uses it to back the
  // autocomplete datalist + chip picker. Access lookup alongside so we
  // can bounce clients out before rendering any task UI.
  // formSchema is fetched only when we're going to render the edit
  // panel — non-edit (read-mode) renders don't need it. Same TTL-cached
  // helper /tasks/new uses, so it's effectively free on a warm cache.
  // getTaskComments reads the full Comments tab via commentsDirect's
  // OWN (uncached) reader — a SEPARATE Sheets GET from tasksGet's
  // (two-layer-cached) readCommentsTab. It only needs the task id
  // (== decodedId), so run it HERE inside the parallel batch instead
  // of awaiting it sequentially after — that took a second full
  // large-sheet read off the critical path (it was the main reason
  // this page felt slow). Errors → [] (banner renders null; the
  // discussion section surfaces its own error).
  // currentUserEmail is hoisted ahead of the batch: it's a cheap
  // session read needed by the form-schema fetch below AND by the
  // notification auto-dismiss further down. Hoisting removes the
  // `.then()` chain that previously serialized the (slow) schema
  // fetch behind it inside the batch (speed pass 2026-06-10).
  const myEmail = (await currentUserEmail().catch(() => "")) || "";
  const [res, peopleRes, accessRes, formSchemaRes, bannerComments] =
    await Promise.all([
      tasksGet(decodedId).catch((e: unknown) => {
        const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
        // Both "task not found" and "access denied" collapse to the
        // same notFound() page below — we don't want either case to
        // bubble up as a server-side 500 with a digest, which is what
        // Omer hit (issue 2026-05-27). A user without access shouldn't
        // be able to tell the difference between "this id doesn't
        // exist" and "you can't see it" anyway, so a 404 is the right
        // shape.
        if (msg.includes("not found") || msg.includes("access denied")) {
          return null;
        }
        throw e;
      }),
      tasksPeopleList().catch(() => ({ ok: false, people: [] })),
      getMyProjects().catch(() => null),
      editing && myEmail
        ? getTaskFormSchema(myEmail).catch(() => null)
        : Promise.resolve(null),
      getTaskComments(decodedId)
        .then((d) => d.comments)
        .catch(() => []),
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

  // `bannerComments` was fetched in the parallel batch above (the
  // approval banner needs it; getTaskComments is React-cache()-wrapped
  // so the discussion section's TaskComments reuses the same result —
  // no second read within this request). On error it's [] and the
  // banner renders null. `myEmail` was hoisted above the batch.

  // Auto-dismiss bell pings about this task. When the user lands on
  // the detail page, any unread Notifications row whose task_id is
  // this task gets silently marked read — no more nagging in the
  // header bell + /notifications list after they've already acted.
  // Maayan reported 2026-05-12: post-action notifications stayed
  // unread and cluttered the inbox even though the task was
  // already taken care of.
  //
  // Fire-and-forget, identical to the markReadByProjectAndKind
  // pattern the projects page uses for chat_mention. Errors are
  // swallowed — missing a dismissal is a UX nit, not a correctness
  // bug. The next bell-badge poll picks up the new read state.
  if (myEmail) {
    void import("@/lib/notifications").then((m) =>
      m.markReadByTask(myEmail, t.id).catch(() => {}),
    );
  }

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
  // Ad-platform deep-link gate — see lib/adLinkAccess.ts for the why.
  // Scoped to Media role + Felix; same helper is used on /morning and
  // (manually mirrored) on the legacy dashboard's project cards so the
  // gate stays consistent across surfaces.
  const showAdLinks = canViewAdLinks(subjectEmail, peopleRes?.people);
  // Phase 4b dependencies — when this task IS an umbrella container,
  // fetch its children so the body render can list them with status
  // badges + drill-down links. Children = rows in the same project
  // whose `umbrella_id` points back. We piggyback on tasksList (with
  // include_umbrellas=true so the umbrella's siblings — if any — also
  // surface for completeness; we filter to umbrella_id ourselves).
  //
  // Phase 6a dependencies — when this task has dep edges (blocks /
  // blocked_by non-empty) we also need the project's tasks to look
  // up titles/statuses for the side-panel deps block. The same
  // tasksList call serves BOTH purposes — single Sheets read,
  // already cached per request.
  const needsProjectFetch =
    t.is_umbrella ||
    (t.blocks?.length ?? 0) > 0 ||
    (t.blocked_by?.length ?? 0) > 0;
  // Inline-template preview — find a brief file in the task's
  // Drive folder so we can render it as a read-only iframe. Two-step
  // probe: list the task folder's children → if it has a "בריפים"
  // sub-folder, list ITS children → look for a Doc/Sheet/Slides
  // whose name contains the task id. Falls back to root-level
  // (טיוטה) detection so legacy tasks (created before the brief
  // restructure) still get a preview.
  const taskFolderFilesPromise: Promise<DriveFile[]> =
    !t.is_umbrella && t.drive_folder_id
      ? listFolderFiles(subjectEmail, t.drive_folder_id).catch(() => [])
      : Promise.resolve([]);
  const [roundChain, driveName, adLinks, projectTasksForDeps, taskFolderFiles] =
    await Promise.all([
      t.round_number > 1 || t.parent_id
        ? fetchRoundChain(t).catch(() => [])
        : Promise.resolve([]),
      subjectEmail
        ? getSharedDriveName(subjectEmail).catch(() => "")
        : Promise.resolve(""),
      showAdLinks && t.project
        ? getProjectAdLinks(t.project).catch(() => null)
        : Promise.resolve(null),
      needsProjectFetch
        ? tasksList({ project: t.project, include_umbrellas: true })
            .then((r) => r.tasks ?? [])
            .catch(() => [] as WorkTask[])
        : Promise.resolve([] as WorkTask[]),
      taskFolderFilesPromise,
    ]);
  const TEMPLATE_MIMES = new Set([
    "application/vnd.google-apps.document",
    "application/vnd.google-apps.spreadsheet",
    "application/vnd.google-apps.presentation",
  ]);
  // Step 1: legacy fallback — look for a `(טיוטה)` file at the task
  // folder root (pre-restructure layout, before adopt-as-brief).
  let templateFile: DriveFile | null =
    taskFolderFiles.find(
      (f) => /\(טיוטה\)\s*$/.test(f.name) && TEMPLATE_MIMES.has(f.mimeType),
    ) || null;
  // Step 2: new layout — look for a בריפים sub-folder + scan its
  // children for a file whose name contains the task id (canonical
  // brief naming = "...task.id" suffix).
  if (!templateFile && !t.is_umbrella && t.drive_folder_id) {
    const taskFolderSubfolders = await listFolderChildren(
      subjectEmail,
      t.drive_folder_id,
    ).catch(() => []);
    const briefsFolder = taskFolderSubfolders.find(
      (c) => c.name === "בריפים",
    );
    if (briefsFolder) {
      const briefs = await listFolderFiles(
        subjectEmail,
        briefsFolder.id,
      ).catch(() => [] as DriveFile[]);
      templateFile =
        briefs.find(
          (f) => f.name.includes(t.id) && TEMPLATE_MIMES.has(f.mimeType),
        ) || null;
    }
  }
  // Derive umbrella children list from the same fetched set.
  const umbrellaChildren = t.is_umbrella
    ? projectTasksForDeps.filter((c) => c.umbrella_id === t.id)
    : ([] as WorkTask[]);
  // Build the dep-lookup map (id → minimal info) for TaskDependencyLinks.
  const depIds = new Set([...(t.blocks || []), ...(t.blocked_by || [])]);
  const depLookup = new Map<
    string,
    { title: string; status: WorkTask["status"] }
  >();
  for (const x of projectTasksForDeps) {
    if (depIds.has(x.id)) {
      depLookup.set(x.id, { title: x.title, status: x.status });
    }
  }
  const localPaths = buildLocalDrivePaths({
    driveName,
    company: t.company,
    project: t.project,
    campaign: t.campaign,
    userEmail: subjectEmail,
  });

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
                  {displayProjectOrCompany(t.company)}
                </Link>
                {" / "}
              </>
            )}
            <Link href={`/projects/${encodeURIComponent(t.project)}`}>
              {displayProjectOrCompany(t.project)}
            </Link>
            {/* Brief (= the task's `campaign`) as the trailing crumb:
                company / project / brief. Plain text — there's no
                brief-specific page to link to. Hidden when empty (e.g.
                umbrellas / project-level tasks with no brief). */}
            {t.campaign && (
              <>
                {" / "}
                <span className="task-detail-crumb-brief">{t.campaign}</span>
              </>
            )}
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
            {/* Contextual "next step" prompt — sits inline with the
                status pill so the most-obvious action is one click
                away instead of buried in the dropdown. See
                TaskActionPrompt for the role × status matrix:
                  • assignee + awaiting_handling → התחל לעבוד
                  • assignee + in_progress       → הגש לאישור
                  • approver + awaiting_approval → אשר / החזר לטיפול / דחה
                Renders null in every other (role × status) combo,
                falling through to the pill's own dropdown. */}
            {myEmail && <TaskActionPrompt task={t} myEmail={myEmail} />}
            {/* Quick pause/play time-tracker — companion to the side-
                panel TaskTimeTracker block. Only renders when the
                task is in_progress AND there's no manual minute
                override on the row (override takes the auto value out
                of the equation; pausing it is meaningless). One-click
                pause/resume while you're deep in the task body. */}
            {!t.is_umbrella &&
              t.status === "in_progress" &&
              (t.inprogress_minutes ?? null) === null &&
              (() => {
                const ip = deriveInProgressTime(
                  t.status_history || [],
                  t.status,
                  t.time_pauses || [],
                );
                // Assignee-only gate. Mirrors the server-side check
                // in /api/tasks/time-pause: only people on the task
                // (plus admins) can fiddle with its timer.
                const lcMe = myEmail.toLowerCase().trim();
                const isAssignee = (t.assignees || []).some(
                  (a) => String(a).toLowerCase().trim() === lcMe,
                );
                const canPause = isAssignee || !!accessRes?.isAdmin;
                return (
                  <TaskTimePauseQuick
                    taskId={t.id}
                    isRunning={ip.isRunning}
                    isPaused={ip.isPaused}
                    autoMinutes={ip.minutes}
                    runningSinceIso={ip.runningSinceIso}
                    canPause={canPause}
                  />
                );
              })()}
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
              className="btn-ghost btn-sm btn-with-brand-icon"
              title={
                adLinks.gAdsAcctName
                  ? `Google Ads — ${adLinks.gAdsAcctName}` +
                    (adLinks.adCampaignPatterns.length
                      ? `\nתבניות קמפיין: ${adLinks.adCampaignPatterns.join(", ")}`
                      : "")
                  : "פתח ב-Google Ads"
              }
            >
              <GoogleAdsIcon size="1.05em" /> Google Ads
            </a>
          )}
          {adLinks?.fbAdsUrl && (
            <a
              href={adLinks.fbAdsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-ghost btn-sm btn-with-brand-icon"
              title={
                adLinks.fbAcctName
                  ? `Facebook Ads — ${adLinks.fbAcctName}` +
                    (adLinks.adCampaignPatterns.length
                      ? `\nתבניות קמפיין: ${adLinks.adCampaignPatterns.join(", ")}`
                      : "")
                  : "פתח ב-Facebook Ads"
              }
            >
              <FacebookAdsIcon size="1.05em" /> Facebook Ads
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
          {localPaths.windows && (
            <CopyLocalPathButton
              path={localPaths.windows}
              pathMac={localPaths.mac}
              title="העתק נתיב מקומי — Drive Desktop"
            />
          )}
          {!editing && (() => {
            // Author-only edit affordance — server enforces the same
            // gate at lib/tasksWriteDirect.ts so a non-author hitting
            // ?edit=1 directly would just get a save error. Hiding the
            // button removes the surprise. Admins always see it.
            const me = subjectEmail.toLowerCase().trim();
            const author = (t.author_email || "").toLowerCase().trim();
            const canEdit = !!accessRes?.isAdmin || (author && author === me);
            if (!canEdit) return null;
            return (
              <Link
                href={`/tasks/${encodeURIComponent(t.id)}?edit=1`}
                className="btn-ghost btn-sm"
              >
                ✏️ ערוך
              </Link>
            );
          })()}
          {/* Edit surface is now the same TaskCreateForm component used
              on /tasks/new — when given an `editingTask` prop it switches
              to update semantics (POST /api/worktasks/update with a
              patch) and hides the create-only chain / multi-mode UI.
              Personal-note → real-project conversion still works via the
              project picker — leaving __personal__ triggers the same
              server-side migration. */}
        </div>
      </header>

      {editing && (
        <TaskCreateForm
          editingTask={t}
          projects={(accessRes?.projects ?? []).map((p) => ({
            name: p.name,
            company: p.company,
            projectManagerFull: p.roster?.projectManagerFull ?? "",
          }))}
          defaultProject={t.project.startsWith("__") ? "" : t.project}
          defaultCompany={t.company || ""}
          people={peopleRes?.people ?? []}
          currentUserEmail={subjectEmail}
          formSchema={
            formSchemaRes && !formSchemaRes.isEmpty
              ? {
                  departments: formSchemaRes.departments,
                  allKinds: formSchemaRes.allKinds,
                  kindsByDepartment: formSchemaRes.kindsByDepartment,
                }
              : null
          }
        />
      )}

      <section className="task-detail-grid">
        {/* Phase 4b dependencies — umbrella container rows render a
            different body (aggregate progress + child list); side
            panel is also slimmed since umbrellas have no own work. */}
        {t.is_umbrella ? (
          <UmbrellaDetailMain umbrella={t} children={umbrellaChildren} />
        ) : (
        <div className="task-detail-main">
          {/* Pending-completion banner — appears when a Google Task
              completion is awaiting confirmation. Stays at the top of
              the body so it can't be missed. The component returns
              null when the claim is empty, so it's safe to mount
              unconditionally. */}
          {t.pending_complete && (
            <TaskApprovalConfirmBanner
              taskId={t.id}
              claimJson={t.pending_complete}
              people={peopleRes?.people ?? []}
            />
          )}
          {t.description && (
            <div className="task-detail-body">
              {linkifyParagraphs(t.description)}
            </div>
          )}

          {/* Submission banner — surfaces the latest "🔍 הוגש לאישור" /
              "❓ ממתין לבירור" comment WITH approve / reject / clarify
              action buttons (when the viewer is the approver / author /
              admin). Sits right under the description so the action
              the user needs to take is the FIRST thing they see —
              previously the submission was buried in the discussion
              section below the tabs. Renders null unless the task is
              in a banner-eligible status AND a matching comment
              exists. Reported by Maayan 2026-05-12. */}
          <TaskApprovalBanner
            task={t}
            comments={bannerComments}
            myEmail={myEmail}
            people={peopleRes?.people ?? []}
          />

          {/* Inline template preview — read-only iframe of the
              filled-in template that lives in the task's Drive
              folder. Detected by `(טיוטה)` suffix on the file name +
              Google Doc/Sheet/Slides mime. Renders nothing when no
              such file exists, so non-template tasks are unaffected. */}
          {templateFile && (
            <TaskTemplatePreview
              fileId={templateFile.id}
              fileName={templateFile.name}
              mimeType={templateFile.mimeType}
              editUrl={templateFile.webViewLink}
            />
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
            <TaskStatusHistory
              history={t.status_history || []}
              descriptionHistory={t.description_history || []}
              people={peopleRes?.people ?? []}
            />
          </section>

          <section
            id="task-files"
            className="task-detail-section task-detail-section-files"
          >
            {/* Unified files panel — the task's main בריף folder
                contents with drag-reorder + drag-drop upload. Mounted
                above the chat-attachments grid so both file surfaces
                live together under the קבצים tab without competing.
                Future: may absorb TaskAttachments when we collapse
                the "main folder" + "attachments subfolder" distinction. */}
            <TaskFilesPanel
              taskId={t.id}
              folderId={t.drive_folder_id || ""}
              folderUrl={t.drive_folder_url}
              company={t.company}
              project={t.project}
              campaign={t.campaign}
              taskTitle={t.title}
              fileOrder={t.file_order || ""}
              localPath={localPaths.windows}
              localPathMac={localPaths.mac}
            />
            <TaskAttachments
              taskId={t.id}
              taskTitle={t.title}
              driveFolderId={t.drive_folder_id}
              driveFolderUrl={t.drive_folder_url}
              localPath={localPaths.windows}
              localPathMac={localPaths.mac}
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
        )}

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

          {/* Phase 6a dependencies — chain context block. Self-renders
              null when both blocks/blocked_by are empty, so the panel
              stays compact for non-chain tasks. Placed above the
              People block so chain state is the first thing users see
              when relevant. */}
          <TaskDependencyLinks task={t} lookup={depLookup} />

          {/* "סבבים" mini-list — surfaces the round chain at the very
              top of the side panel when this task is part of one (i.e.
              has siblings via parent_id). The same chain links also
              live deep in the פרטים block via RoundRow, but the audit
              flagged that as too easy to miss when reviewing a later
              round. Top placement makes the round context the first
              thing the eye lands on for multi-round tasks; single-
              round tasks skip this block entirely (the inline "ראשון"
              label inside פרטים is enough). */}
          {roundChain.length > 1 && (
            <SideBlock title="סבבים">
              <RoundRow task={t} chain={roundChain} />
            </SideBlock>
          )}

          {/* Umbrellas have no own assignees/approver/PM; suppress the
              People block entirely so the panel doesn't show 4 empty
              rows. The (umbrella's children) people are surfaced
              individually on each child's drill-down. */}
          {!t.is_umbrella && (
            <SideBlock title="אנשים">
              <PersonRow
                label="כותב"
                email={t.author_email}
                filterKey="author"
                people={peopleRes?.people ?? []}
              />
              <PersonRow
                label="גורם מאשר"
                email={t.approver_email}
                filterKey="approver"
                people={peopleRes?.people ?? []}
              />
              <PersonRow
                label="מנהל פרויקט"
                email={t.project_manager_email}
                filterKey="project_manager"
                people={peopleRes?.people ?? []}
              />
              <PeopleRow
                label="עובדים במשימה"
                emails={t.assignees || []}
                filterKey="assignee"
                people={peopleRes?.people ?? []}
              />
            </SideBlock>
          )}

          {/* Optional per-task time tracking — append-only, informational
              (does NOT drive billing; that stays on the flat Pricingsetup
              price). Suppressed for umbrella containers (no own work, like
              the People block) and in edit mode (the aside is inert then,
              and an interactive tracker there would mislead). */}
          {!editing && !t.is_umbrella && (() => {
            // Status-derived in-progress time (the counter "starts on
            // בעבודה, stops on the next status change"). Computed here
            // server-side from status_history; the manual override on
            // the row supersedes it when set.
            const ip = deriveInProgressTime(
              t.status_history || [],
              t.status,
              t.time_pauses || [],
            );
            // Assignee/admin gate — same as the inline pause button.
            // Non-assignees see the counter + override controls but
            // not the live pause/resume affordance.
            const lcMe = myEmail.toLowerCase().trim();
            const canPause =
              !!accessRes?.isAdmin ||
              (t.assignees || []).some(
                (a) => String(a).toLowerCase().trim() === lcMe,
              );
            return (
              <SideBlock title="מעקב זמן">
                <TaskTimeTracker
                  taskId={t.id}
                  autoMinutes={ip.minutes}
                  isRunning={ip.isRunning}
                  isPaused={ip.isPaused}
                  overrideMinutes={t.inprogress_minutes ?? null}
                  canPause={canPause}
                />
              </SideBlock>
            );
          })()}

          {/* Schedule — when-this-task-is dates. Pulled out of פרטים
              (where created/updated lived) and the page header (where
              requested_date appeared as an inline chip) so the three
              dates read as a single block instead of being scattered
              across the page. The header chip stays for at-a-glance
              context — this side block is for the careful read. */}
          <SideBlock title="לוח זמנים">
            <KV
              label="תאריך מבוקש"
              value={
                t.requested_date
                  ? t.requested_date.slice(0, 16).replace("T", " ")
                  : "—"
              }
            />
            <KV label="נוצר" value={t.created_at.slice(0, 16).replace("T", " ")} />
            <KV label="עודכן" value={t.updated_at.slice(0, 16).replace("T", " ")} />
          </SideBlock>

          {/* Meta — everything else. Merges the previous "שיוך"
              (company/project/campaign) and "פרטים" (kind/departments/
              round/id) blocks into a single bucket since both were
              just task metadata; the dates moving to לוח זמנים lets
              this block stay short enough that the merge reads cleaner
              than the previous two-block split. */}
          <SideBlock title="מטא">
            <KV label="חברה" value={displayProjectOrCompany(t.company) || "—"} />
            <KV label="פרויקט" value={displayProjectOrCompany(t.project)} />
            <KV label="בריף" value={t.campaign || "—"} />
            <KV label="סוג" value={t.kind} />
            <KV label="מחלקות" value={(t.departments || []).join(", ") || "—"} />
            {/* For single-round tasks, RoundRow shows the simple
                "ראשון" label here. Multi-round tasks have the chain
                hoisted to the top "סבבים" block above; suppressing the
                duplicate here keeps the panel tidy. */}
            {roundChain.length <= 1 && (
              <RoundRow task={t} chain={roundChain} />
            )}
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
  people,
}: {
  label: string;
  email: string;
  filterKey: string;
  people?: TasksPerson[];
}) {
  return (
    <div className="task-kv">
      <dt>{label}</dt>
      <dd>
        {email ? (
          <PersonChip email={email} filterKey={filterKey} people={people} />
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
  people,
}: {
  label: string;
  emails: string[];
  filterKey: string;
  people?: TasksPerson[];
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
              <PersonChip
                key={email}
                email={email}
                filterKey={filterKey}
                people={people}
              />
            ))}
          </div>
        )}
      </dd>
    </div>
  );
}

function PersonChip({
  email,
  filterKey,
  people,
}: {
  email: string;
  filterKey: string;
  people?: TasksPerson[];
}) {
  return (
    <Link
      href={`/tasks?${filterKey}=${encodeURIComponent(email)}`}
      className="task-person-chip"
      title={email}
    >
      <Avatar name={email} title={email} size={22} />
      <span className="task-person-chip-name">
        {personDisplayName(email, people)}
      </span>
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
