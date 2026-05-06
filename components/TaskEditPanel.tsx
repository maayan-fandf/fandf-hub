"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { TasksPerson, WorkTask } from "@/lib/appsScript";
import CampaignCombobox from "./CampaignCombobox";
import DatePicker from "./DatePicker";
import PeopleMultiCombobox from "./PeopleMultiCombobox";
import DriveFolderPicker, {
  type FolderPickerValue,
} from "./DriveFolderPicker";
import { displayNameOf } from "@/lib/personDisplay";

const DEPARTMENTS = ["מדיה", "קריאייטיב", "UI/UX", "תכנון", "אחר"];
const KINDS = [
  { val: "ad_creative", label: "קריאייטיב פרסומי" },
  { val: "landing_page", label: "דף נחיתה" },
  { val: "video", label: "וידאו" },
  { val: "copy", label: "קופי" },
  { val: "campaign_launch", label: "השקת קמפיין" },
  { val: "revision", label: "סבב תיקונים" },
  { val: "other", label: "אחר" },
];
// `sub_status` is a legacy Data-Plus field — the hub stored values
// on the row but no surface ever read them back. Retired 2026-05-06
// per Maayan: the edit panel's UI is gone, the write path no longer
// includes it in patches, and the column isn't dropped (preserves
// historical data). New tasks created after this commit don't write
// to it; existing rows keep their values for archival purposes.

export default function TaskEditPanel({
  task,
  people,
  projects = [],
}: {
  task: WorkTask;
  people: TasksPerson[];
  /** User's accessible projects, used as the datalist for the project
   *  field. When omitted, the project field still accepts free-form
   *  input (just no autocomplete). The dominant flow that depends on
   *  this is "promote a personal note (__personal__) to a real project"
   *  — typing the new project name here moves the row, backfills the
   *  Drive folder, and updates the company server-side. */
  projects?: { name: string; company: string }[];
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState(task.title || "");
  const [description, setDescription] = useState(task.description || "");
  // Legacy `brief` field — UI was removed but existing values are passed
  // through on edit so we don't accidentally wipe data on tasks that
  // previously had it set. Will be retired from the data model later.
  const brief = task.brief || "";
  const [departments, setDepartments] = useState<string[]>(
    task.departments || [],
  );
  const [kind, setKind] = useState(task.kind || "other");
  const [priority, setPriority] = useState(String(task.priority || 2));
  // requested_date is stored as YYYY-MM-DD or YYYY-MM-DDTHH:MM.
  // Split into separate inputs for the form so users can clear one
  // without the other. Recombined on save.
  const initialRaw = task.requested_date || "";
  const initialDate = initialRaw.match(/^\d{4}-\d{2}-\d{2}/)?.[0] || "";
  const initialTime = initialRaw.match(/[T\s](\d{2}:\d{2})/)?.[1] || "";
  const [requestedDate, setRequestedDate] = useState(initialDate);
  const [requestedTime, setRequestedTime] = useState(initialTime);
  const [approver, setApprover] = useState(task.approver_email || "");
  const [projectManager, setProjectManager] = useState(
    task.project_manager_email || "",
  );
  const [assignees, setAssignees] = useState(
    (task.assignees || []).join(", "),
  );
  // Pseudo-project rows (`__personal__`, future `__inbox__`, etc.) start
  // with an EMPTY project field even though the underlying value is
  // `__personal__`. Reasoning: when the input is pre-filled with the
  // literal pseudo string, the browser's datalist filters to "options
  // that match `__personal__`" — i.e. nothing — so clicking the dropdown
  // caret looks broken (no projects shown). Initializing empty makes the
  // placeholder hint visible AND lets the full project list drop down
  // immediately. The save logic at line ~150 only sends `patch.project`
  // when the field is non-empty AND differs from the row's current
  // value, so an empty field saved unchanged correctly keeps the row on
  // its pseudo-project.
  const startsAsPseudo = task.project.startsWith("__");
  const [project, setProject] = useState(
    startsAsPseudo ? "" : task.project || "",
  );
  // Selected company drives the project datalist's narrowing while a
  // pseudo-task is being promoted. Only relevant in the pseudo path —
  // real-project rows show company as a readonly auto-derived display
  // (the row's own `task.company` value).
  const [selectedCompany, setSelectedCompany] = useState("");
  const [campaign, setCampaign] = useState(task.campaign || "");
  const [campaignOptions, setCampaignOptions] = useState<string[]>([]);
  const [campaignReloadNonce, setCampaignReloadNonce] = useState(0);
  // Folder picker is shown in its own section below; in edit-mode we
  // only patch `drive_folder_id` if the user actually picks a different
  // folder. Default selection reflects whatever the task points at.
  const [folderSelection, setFolderSelection] = useState<FolderPickerValue>(
    task.drive_folder_id
      ? { mode: "existing", folderId: task.drive_folder_id }
      : { mode: "new", name: task.title || task.id },
  );
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  // Effective project for downstream lookups: local `project` state
  // (what the user has currently typed/picked) takes precedence over
  // the server-side row value, so promoting a personal task immediately
  // re-fetches campaigns for the newly-picked project. Falls back to
  // `task.project` only when the input is blank — relevant on first
  // open of a non-pseudo task before the user changes anything.
  const effectiveProject = project.trim() || task.project;
  useEffect(() => {
    let cancelled = false;
    // Skip the fetch for pseudo projects (`__personal__`, etc.) — the
    // /api/tasks/campaigns endpoint runs an access-scope check that
    // legitimately rejects them. Empty string is rejected too. Either
    // case we just want an empty options list.
    if (!effectiveProject || effectiveProject.startsWith("__")) {
      setCampaignOptions([]);
      return;
    }
    fetch(`/api/tasks/campaigns?project=${encodeURIComponent(effectiveProject)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        setCampaignOptions((data?.campaigns ?? []) as string[]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [effectiveProject, campaignReloadNonce]);

  // Derive company options from the project list (passed from the
   // page's access-scoped getMyProjects). Used by the pseudo-task
   // promote flow's company select.
  const companyOptions = useMemo(() => {
    const set = new Set<string>();
    for (const p of projects) {
      if (p.company) set.add(p.company);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, "he"));
  }, [projects]);
  // Project datalist narrows to the selected company when one is
  // picked; otherwise the full list (deduped by name) shows.
  const filteredProjects = useMemo(() => {
    const seen = new Set<string>();
    const source = selectedCompany
      ? projects.filter((p) => p.company === selectedCompany)
      : projects;
    const out: { name: string; company: string }[] = [];
    for (const p of source) {
      if (seen.has(p.name)) continue;
      seen.add(p.name);
      out.push(p);
    }
    return out;
  }, [projects, selectedCompany]);
  // When the user picks a project (typing or selecting an option),
  // back-fill the company select if the chosen project unambiguously
  // belongs to one. Keeps the two fields in lockstep so picking a
  // project from "all companies" mode also reveals which company it's
  // under.
  function syncCompanyFromProject(pickedProject: string) {
    const trimmed = pickedProject.trim();
    if (!trimmed) return;
    const matches = projects.filter((p) => p.name === trimmed);
    if (matches.length === 1 && matches[0].company) {
      setSelectedCompany(matches[0].company);
    }
  }

  function toggleDept(d: string) {
    setDepartments((cur) =>
      cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d],
    );
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setError(null);

    const assigneeList = assignees
      .split(/[,;\n]/)
      .map((s) => s.trim())
      .filter(Boolean);

    const combinedRequestedDate =
      requestedDate && requestedTime
        ? `${requestedDate}T${requestedTime}`
        : requestedDate;

    // sub_status retired 2026-05-06 — no longer included in patches.
    // Existing rows keep their stored value; new edits don't touch it.
    const patch: Record<string, unknown> = {
      title,
      description,
      brief,
      departments,
      kind,
      priority: Number(priority),
      requested_date: combinedRequestedDate,
      approver_email: approver,
      project_manager_email: projectManager,
      assignees: assigneeList,
      campaign: campaign.trim(),
    };
    // Only include `project` in the patch when the user actually moved
    // the task. The server-side update path treats project changes
    // specially (validates access to the new project + backfills a
    // Drive folder when leaving __personal__) and we want those side
    // effects to fire only when the value really changed.
    const projectTrimmed = project.trim();
    if (projectTrimmed && projectTrimmed !== task.project) {
      patch.project = projectTrimmed;
    }
    // Only include drive_folder_id if the user actually picked a
    // different existing folder — no-op otherwise. Re-pointing to "new"
    // is deliberately not supported from the edit panel for now.
    if (
      folderSelection.mode === "existing" &&
      folderSelection.folderId &&
      folderSelection.folderId !== task.drive_folder_id
    ) {
      patch.drive_folder_id = folderSelection.folderId;
    }

    try {
      const res = await fetch("/api/worktasks/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: task.id, patch }),
      });
      const data = (await res.json()) as
        | { ok: true; changed: boolean }
        | { ok: false; error: string };
      if (!res.ok || !data.ok) {
        throw new Error(
          "error" in data ? data.error : "Failed to save changes",
        );
      }
      // Strip ?edit=1 and refresh the server component so the
      // read-only view reflects the new values.
      router.replace(`/tasks/${encodeURIComponent(task.id)}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <form className="task-form task-edit-panel" onSubmit={onSubmit}>
      <div className="task-edit-panel-head">
        <h2>עריכת משימה</h2>
        <p className="subtitle">
          שינויים נשמרים למשימה ולוג הסטטוסים — לא נשלח מייל חדש לגורם המאשר.
          העברת המשימה לפרויקט אחר תיצור תיקייה חדשה ב־Drive במידת הצורך.
        </p>
      </div>

      {error && <div className="error">{error}</div>}

      <datalist id="tasks-people-edit">
        {people.map((p) => (
          <option key={p.email} value={p.email}>
            {displayNameOf(p)} · {p.role}
          </option>
        ))}
      </datalist>
      {/* Separate datalist for the מנהל פרויקט field — narrowed to
          role values containing "manager" (today: "manager" + "client
          manager"). The unfiltered list dumped every employee into
          the autocomplete, which made designers/copywriters/video
          editors look like valid PM picks. Falls back to the full
          list when no role matches the substring (defensive — keeps
          the picker usable if the column hasn't been populated). */}
      <datalist id="tasks-pms-edit">
        {(() => {
          const matches = people.filter((p) =>
            (p.role || "").toLowerCase().includes("manager"),
          );
          const list = matches.length > 0 ? matches : people;
          return list.map((p) => (
            <option key={p.email} value={p.email}>
              {displayNameOf(p)} · {p.role}
            </option>
          ));
        })()}
      </datalist>

      <div className="task-form-row">
        {/* Field order [company, project, brief] — matches the
            convention used by /tasks filter bar, /tasks/new form,
            and the queue table headers. RTL means the first child
            is rendered rightmost, so this lays out as:
                חברה  →  פרויקט  →  בריף  (right to left)
            Reported by Maayan 2026-05-06 — the previous pseudo-task
            edit mode flipped this and looked inconsistent with the
            rest of the task surfaces. */}
        {startsAsPseudo ? (
          <label>
            חברה
            <select
              value={selectedCompany}
              onChange={(e) => {
                const next = e.target.value;
                setSelectedCompany(next);
                // If the currently-typed project doesn't belong to
                // the new company, clear it so the user doesn't end
                // up with a hidden mismatch (project not in the
                // narrowed list anymore).
                if (project) {
                  const stillValid = projects.some(
                    (p) =>
                      p.name === project &&
                      (!next || p.company === next),
                  );
                  if (!stillValid) setProject("");
                }
              }}
              data-active={selectedCompany ? "1" : undefined}
            >
              <option value="">בחר חברה (לסינון פרויקטים)…</option>
              {companyOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label>
            חברה (אוטומטית)
            <input
              type="text"
              value={task.company || "—"}
              disabled
              readOnly
              title="החברה נקבעת אוטומטית לפי הפרויקט"
            />
          </label>
        )}
        <label>
          פרויקט
          <input
            type="text"
            value={project}
            list="task-edit-projects"
            onChange={(e) => {
              setProject(e.target.value);
              // Try to back-fill the company on every change so the
              // datalist's "auto-suggest match → enter" path lights
              // up the company too. Cheap — Map lookup against props.
              if (startsAsPseudo) syncCompanyFromProject(e.target.value);
            }}
            placeholder={
              startsAsPseudo
                ? selectedCompany
                  ? `הזן שם פרויקט מ־${selectedCompany}`
                  : "הזן שם פרויקט להעברת ההערה"
                : "שם פרויקט"
            }
          />
          <datalist id="task-edit-projects">
            {filteredProjects.map((p) => (
              <option key={`${p.company}|${p.name}`} value={p.name}>
                {p.company ? `${p.company} · ${p.name}` : p.name}
              </option>
            ))}
          </datalist>
        </label>
        <label>
          בריף
          <CampaignCombobox
            value={campaign}
            onChange={setCampaign}
            options={campaignOptions}
            // Mirror the effective project used for the campaigns
            // fetch — passing `task.project` (a stale __personal__
            // for promoted-pseudo rows) made create-new campaign land
            // on the wrong project tree.
            project={effectiveProject}
            onOptionsChanged={() => setCampaignReloadNonce((n) => n + 1)}
            placeholder="בחר בריף קיים או הקלד חדש"
            hint={
              campaignOptions.length > 0 ? "ממוין מהחדש לישן" : undefined
            }
          />
        </label>
      </div>

      <div className="drive-folder-section">
        <div className="drive-folder-section-head">
          <strong>תיקיית Drive</strong>
          {task.drive_folder_url && (
            <a
              href={task.drive_folder_url}
              target="_blank"
              rel="noreferrer"
              className="drive-folder-link"
            >
              פתח תיקייה נוכחית ↗
            </a>
          )}
          <button
            type="button"
            className="drive-folder-btn-ghost"
            onClick={() => setShowFolderPicker((v) => !v)}
          >
            {showFolderPicker ? "סגור" : "החלף תיקייה"}
          </button>
        </div>
        {showFolderPicker && (
          <DriveFolderPicker
            compact
            company={task.company || ""}
            project={task.project}
            campaign={campaign}
            defaultNewName={task.title || task.id}
            value={folderSelection}
            onChange={setFolderSelection}
            onCampaignChange={setCampaign}
          />
        )}
      </div>

      <label>
        כותרת
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
      </label>

      <label>
        תיאור
        <textarea
          rows={5}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>

      <label>
        מחלקות
        <div className="task-form-dept-row">
          {DEPARTMENTS.map((d) => (
            <button
              key={d}
              type="button"
              className={`task-form-dept-chip${
                departments.includes(d) ? " is-active" : ""
              }`}
              onClick={() => toggleDept(d)}
            >
              {d}
            </button>
          ))}
        </div>
      </label>

      <div className="task-form-row">
        <label>
          סוג
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map((k) => (
              <option key={k.val} value={k.val}>
                {k.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          דחיפות
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          >
            <option value="1">1 — גבוהה</option>
            <option value="2">2 — רגילה</option>
            <option value="3">3 — נמוכה</option>
          </select>
        </label>

        <label className="task-form-date-time">
          תאריך מבוקש
          <div className="date-time-inputs">
            <DatePicker
              value={requestedDate}
              onChange={setRequestedDate}
            />
            <input
              type="time"
              value={requestedTime}
              onChange={(e) => setRequestedTime(e.target.value)}
              aria-label="שעה (אופציונלי)"
              title="שעה (אופציונלי)"
            />
          </div>
        </label>
      </div>

      <div className="task-form-row">
        <label>
          גורם מאשר
          <input
            type="text"
            list="tasks-people-edit"
            value={approver}
            onChange={(e) => setApprover(e.target.value)}
            placeholder="name@fandf.co.il"
          />
        </label>

        <label>
          מנהל פרויקט
          <input
            type="text"
            list="tasks-people-edit"
            value={projectManager}
            onChange={(e) => setProjectManager(e.target.value)}
            placeholder="name@fandf.co.il"
          />
        </label>

      </div>

      <label>
        עובדים במשימה
        {/* Same swap as TaskCreateForm — emails-as-textarea replaced
            with a Hebrew-name chip combobox so this row reads in
            sync with the rest of the edit panel's person fields.
            The bubble row below stays as quick-toggle. */}
        <PeopleMultiCombobox
          value={assignees}
          onChange={setAssignees}
          options={people}
          placeholder="חפש לפי שם או מייל"
        />
        {people.length > 0 && (
          <div className="task-form-assignee-chips">
            {people.slice(0, 24).map((p) => {
              const already = assignees
                .split(/[,;\n]/)
                .map((s) => s.trim().toLowerCase())
                .includes(p.email.toLowerCase());
              return (
                <button
                  key={p.email}
                  type="button"
                  className={`task-form-assignee-chip${
                    already ? " is-active" : ""
                  }`}
                  title={`${displayNameOf(p)} · ${p.role}`}
                  onClick={() => {
                    if (already) {
                      const next = assignees
                        .split(/[,;\n]/)
                        .map((s) => s.trim())
                        .filter(
                          (s) =>
                            s.toLowerCase() !== p.email.toLowerCase(),
                        )
                        .join(", ");
                      setAssignees(next);
                    } else {
                      const cleaned = assignees.replace(/[,;\s]+$/g, "");
                      setAssignees(
                        cleaned ? `${cleaned}, ${p.email}` : p.email,
                      );
                    }
                  }}
                >
                  {displayNameOf(p)}
                </button>
              );
            })}
          </div>
        )}
      </label>

      <div className="task-form-actions">
        <button
          type="button"
          className="btn-ghost"
          onClick={() =>
            router.replace(`/tasks/${encodeURIComponent(task.id)}`)
          }
          disabled={saving}
        >
          בטל
        </button>
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? "שומר…" : "שמור"}
        </button>
      </div>
    </form>
  );
}
