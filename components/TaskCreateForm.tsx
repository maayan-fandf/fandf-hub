"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { TasksPerson } from "@/lib/appsScript";
import CampaignCombobox from "./CampaignCombobox";
import PersonCombobox from "./PersonCombobox";
import DriveFolderPicker, {
  type FolderPickerValue,
} from "./DriveFolderPicker";

/** Hardcoded fallback used only when the names-to-emails sheet has no
 *  Role column populated. Real departments come from the people list
 *  (see `departmentOptions` below) so they stay in sync with the sheet. */
const DEPARTMENTS_FALLBACK = ["מדיה", "קריאייטיב", "UI/UX", "תכנון", "אחר"];
const KINDS = [
  { val: "ad_creative", label: "קריאייטיב פרסומי" },
  { val: "landing_page", label: "דף נחיתה" },
  { val: "video", label: "וידאו" },
  { val: "copy", label: "קופי" },
  { val: "campaign_launch", label: "השקת קמפיין" },
  { val: "revision", label: "סבב תיקונים" },
  { val: "other", label: "אחר" },
];

type ProjectOption = {
  name: string;
  company: string;
  /** Keys col D "EMAIL Manager" — stored as a display name like
   *  "Itay Stein". Resolved to an email client-side via the people list. */
  projectManagerFull: string;
};

export default function TaskCreateForm({
  projects,
  defaultProject,
  defaultCompany: defaultCompanyProp = "",
  defaultDescription = "",
  defaultAssignees = "",
  defaultTitle = "",
  fromComment = "",
  people,
  currentUserEmail,
}: {
  projects: ProjectOption[];
  defaultProject: string;
  /** Pre-fill the company picker WITHOUT pre-selecting a project. Used
   *  by the Gmail-origin task convert flow: the email's sender resolves
   *  to a known client company, but clients are spread across multiple
   *  projects so we let the user pick which project applies. */
  defaultCompany?: string;
  /** Pre-fill the description textarea — used by the "convert comment
   *  to task" flow on /tasks/new?from_comment=X. */
  defaultDescription?: string;
  /** Pre-fill the assignees field as a CSV. The comment's `mentions`
   *  field maps directly here. */
  defaultAssignees?: string;
  /** Pre-fill the title — typically the first line of the source
   *  comment, truncated. The user almost always edits this before
   *  saving, but a starting point beats an empty field. */
  defaultTitle?: string;
  /** When set, the create payload includes `from_comment` so the
   *  server migrates the source comment + its replies under the new
   *  task. Empty string skips the migration (plain create). */
  fromComment?: string;
  people: TasksPerson[];
  currentUserEmail: string;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Company → list-of-projects index, for the cascading dropdowns.
  const byCompany = useMemo(() => {
    const m = new Map<string, ProjectOption[]>();
    for (const p of projects) {
      const co = p.company || "";
      if (!m.has(co)) m.set(co, []);
      m.get(co)!.push(p);
    }
    return m;
  }, [projects]);

  // Resolve a Keys display-name (like "Itay Stein") to an email by
  // matching against the people list by name. Lower-cased exact match;
  // falls back to empty so the user can type the address manually.
  const nameToEmail = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of people) {
      const k = String(p.name || "").trim().toLowerCase();
      if (k && !m.has(k)) m.set(k, p.email);
    }
    return m;
  }, [people]);

  const defaultProjectOpt = projects.find((p) => p.name === defaultProject);
  // Company defaults: project pick wins (auto-derived); else the explicit
  // ?company param; else empty.
  const defaultCompany = defaultProjectOpt?.company || defaultCompanyProp || "";
  const defaultPm = defaultProjectOpt
    ? nameToEmail.get(defaultProjectOpt.projectManagerFull.trim().toLowerCase()) || ""
    : "";

  const [company, setCompany] = useState(defaultCompany);
  const [project, setProject] = useState(defaultProject);
  const [departments, setDepartments] = useState<string[]>([]);
  const [projectManager, setProjectManager] = useState(defaultPm);
  const [approver, setApprover] = useState("");
  const [assignees, setAssignees] = useState(defaultAssignees);
  const [campaign, setCampaign] = useState("");
  const [title, setTitle] = useState(defaultTitle);
  // Folder selection. Default is "use existing campaign folder" with
  // an empty folderId — the picker auto-selects the campaign folder
  // when it resolves (or, when the campaign folder doesn't exist yet,
  // the server creates it on save and uses it directly — no leaf
  // sub-folder gets created in either case unless the user opts into
  // "תיקייה חדשה" mode and types a name. This was the previous source
  // of duplicate sub-folders matching the campaign name.
  const suggestedFolderName = useMemo(
    () => title.trim().slice(0, 60),
    [title],
  );
  const [folderSelection, setFolderSelection] = useState<FolderPickerValue>({
    mode: "existing",
    folderId: "",
    folderName: "",
  });
  // Track whether the user has manually edited the new-folder name.
  // Once edited, stop overwriting it with the title-derived suggestion.
  const [folderNameUserEdited, setFolderNameUserEdited] = useState(false);
  useEffect(() => {
    if (folderNameUserEdited) return;
    setFolderSelection((cur) =>
      cur.mode === "new"
        ? { mode: "new", name: suggestedFolderName }
        : cur,
    );
  }, [suggestedFolderName, folderNameUserEdited]);
  function handleFolderChange(v: FolderPickerValue) {
    if (
      v.mode === "new" &&
      v.name !== suggestedFolderName &&
      v.name !== ""
    ) {
      setFolderNameUserEdited(true);
    }
    setFolderSelection(v);
  }
  // Existing campaigns for the selected project — populates the
  // datalist autocomplete. Refetched whenever the project changes,
  // and explicitly after CampaignCombobox creates / renames one
  // (it owns the API calls; we own the cached list).
  const [campaignOptions, setCampaignOptions] = useState<string[]>([]);
  const [campaignReloadNonce, setCampaignReloadNonce] = useState(0);
  useEffect(() => {
    if (!project) {
      setCampaignOptions([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/tasks/campaigns?project=${encodeURIComponent(project)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        const list = (data?.campaigns ?? []) as string[];
        setCampaignOptions(list);
      })
      .catch(() => {
        /* ignore; free-text still works */
      });
    return () => {
      cancelled = true;
    };
  }, [project, campaignReloadNonce]);

  const companyProjects = company ? byCompany.get(company) || [] : projects;

  // Departments derived from the live `Role` column on names-to-emails.
  // Falls back to the legacy hardcoded list when no roles are populated
  // (so the form never renders chip-less). This is what makes the
  // department choice and the worker chips below actually agree on the
  // set of categories — request #4 from the queue.
  const departmentOptions = useMemo(() => {
    const set = new Set<string>();
    for (const p of people) {
      const r = (p.role || "").trim();
      if (r) set.add(r);
    }
    if (set.size === 0) return DEPARTMENTS_FALLBACK;
    return Array.from(set).sort((a, b) => a.localeCompare(b, "he"));
  }, [people]);

  // Worker chips (and the assignee combobox secondary list) narrow to
  // people whose role matches one of the selected departments. Empty
  // selection = show everyone, keeping the existing behavior.
  const filteredPeople = useMemo(() => {
    if (departments.length === 0) return people;
    const wanted = new Set(departments.map((d) => d.toLowerCase()));
    return people.filter((p) => wanted.has((p.role || "").toLowerCase()));
  }, [people, departments]);

  function toggleDept(d: string) {
    setDepartments((cur) =>
      cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d],
    );
  }

  function onProjectChange(name: string) {
    setProject(name);
    const opt = projects.find((x) => x.name === name);
    if (opt) {
      // Auto-fill company if user picked project first.
      if (!company && opt.company) setCompany(opt.company);
      // Auto-fill project manager from the project's Keys roster, BUT
      // only if the user hasn't already typed something. This respects
      // manual entry if they're ahead of the cascade.
      const pmEmail = nameToEmail.get(
        opt.projectManagerFull.trim().toLowerCase(),
      );
      if (pmEmail && !projectManager) setProjectManager(pmEmail);
    }
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const fd = new FormData(e.currentTarget);

    const assigneeList = assignees
      .split(/[,;\n]/)
      .map((s) => s.trim())
      .filter(Boolean);

    // Combine optional time-of-day with the date. Stored as either
    // "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM" depending on whether a time
    // was entered. The Google-Tasks side only respects the date; the
    // hub-side renders the time when present.
    const dateRaw = String(fd.get("requested_date") || "").trim();
    const timeRaw = String(fd.get("requested_time") || "").trim();
    const requestedDate =
      dateRaw && timeRaw ? `${dateRaw}T${timeRaw}` : dateRaw;

    const payload: Record<string, unknown> = {
      project: project,
      company: company, // falls back to Keys lookup server-side if empty
      brief: String(fd.get("brief") || ""),
      title: title,
      description: String(fd.get("description") || ""),
      departments,
      kind: String(fd.get("kind") || ""),
      priority: Number(fd.get("priority") || "2"),
      approver_email: approver,
      project_manager_email: projectManager,
      assignees: assigneeList,
      requested_date: requestedDate,
      campaign: campaign.trim(),
    };
    if (fromComment) {
      // Server re-parents the source comment + its replies under the
      // newly-created task id (Flavor C migration).
      payload.from_comment = fromComment;
    }
    if (folderSelection.mode === "existing" && folderSelection.folderId) {
      payload.drive_folder_id = folderSelection.folderId;
    } else if (folderSelection.mode === "new") {
      const name = folderSelection.name.trim();
      if (name) payload.drive_folder_name = name;
    }

    try {
      const res = await fetch("/api/worktasks/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as
        | { ok: true; task: { id: string } }
        | { ok: false; error: string };
      if (!res.ok || !data.ok) {
        throw new Error(
          "error" in data ? data.error : "Failed to create task",
        );
      }
      router.push(`/tasks/${encodeURIComponent(data.task.id)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  const companies = Array.from(byCompany.keys()).filter(Boolean).sort();

  return (
    <form className="task-form" onSubmit={onSubmit}>
      {error && <div className="error">{error}</div>}

      <div className="task-form-row">
        <label>
          חברה
          <select
            value={company}
            onChange={(e) => {
              setCompany(e.target.value);
              setProject(""); // reset — project list changes with company
              setProjectManager(""); // reset PM until new project is picked
            }}
          >
            <option value="">בחר חברה…</option>
            {companies.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>

        <label>
          פרויקט
          <select
            required
            value={project}
            onChange={(e) => onProjectChange(e.target.value)}
          >
            <option value="">בחר פרויקט…</option>
            {companyProjects.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          קמפיין
          <CampaignCombobox
            value={campaign}
            onChange={setCampaign}
            options={campaignOptions}
            project={project}
            onOptionsChanged={() => setCampaignReloadNonce((n) => n + 1)}
            placeholder={
              project
                ? "בחר קמפיין קיים או הקלד חדש"
                : "בחר פרויקט תחילה"
            }
            disabled={!project}
            hint={
              campaignOptions.length > 0
                ? "ממוין מהחדש לישן"
                : undefined
            }
          />
        </label>
      </div>

      <details className="task-form-extra">
        <summary>שדות נוספים</summary>
        <label>
          בריף
          <input
            type="text"
            name="brief"
            placeholder="10431"
            inputMode="text"
          />
        </label>
      </details>

      <label>
        כותרת <span className="task-form-required" aria-hidden>*</span>
        <input
          type="text"
          name="title"
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="לדוגמה: Minisite_desktop — דף נחיתה לקמפיין כפר אז״ר"
        />
      </label>

      <label>
        תיאור
        <textarea
          name="description"
          rows={5}
          placeholder="מה צריך לעשות, מה הקונטקסט, קישורים רלוונטיים…"
          defaultValue={defaultDescription}
        />
      </label>

      <DriveFolderPicker
        company={company}
        project={project}
        campaign={campaign}
        defaultNewName={suggestedFolderName}
        value={folderSelection}
        onChange={handleFolderChange}
        disabled={!project}
      />

      <label>
        מחלקות{" "}
        <span className="task-form-label-hint">
          (ניתן לבחור יותר מאחת — בחירה תסנן את רשימת העובדים בהמשך)
        </span>
        <div className="task-form-dept-row">
          {departmentOptions.map((d) => (
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
          <select name="kind" defaultValue="ad_creative">
            {KINDS.map((k) => (
              <option key={k.val} value={k.val}>
                {k.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          דחיפות
          <select name="priority" defaultValue="2">
            <option value="1">1 — גבוהה</option>
            <option value="2">2 — רגילה</option>
            <option value="3">3 — נמוכה</option>
          </select>
        </label>

        <label className="task-form-date-time">
          תאריך מבוקש
          <div className="date-time-inputs">
            <input type="date" name="requested_date" />
            <input
              type="time"
              name="requested_time"
              aria-label="שעה (אופציונלי)"
              title="שעה (אופציונלי)"
            />
          </div>
        </label>
      </div>

      <div className="task-form-row">
        <label>
          גורם מאשר
          <PersonCombobox
            value={approver}
            onChange={setApprover}
            options={people}
            placeholder="חפש לפי שם או מייל"
          />
        </label>

        <label>
          מנהל פרויקט
          <PersonCombobox
            value={projectManager}
            onChange={setProjectManager}
            options={people}
            placeholder="חפש לפי שם או מייל"
            hint={defaultPm ? "ברירת מחדל: מנהל הפרויקט מ־Keys" : undefined}
          />
        </label>

        <label>
          עובדים במשימה
          <textarea
            rows={2}
            value={assignees}
            onChange={(e) => setAssignees(e.target.value)}
            placeholder="felix@fandf.co.il, nadav@fandf.co.il"
          />
          {departments.length > 0 && (
            <div className="task-form-dept-filter-line">
              מסונן לפי{" "}
              {departments.map((d) => (
                <span key={d} className="task-form-dept-filter-pill">
                  {d}
                </span>
              ))}
              {filteredPeople.length === 0 && (
                <span className="task-form-dept-filter-empty">
                  אין עובדים תחת מחלקות אלה — בחר אחרות או הסר סינון
                </span>
              )}
            </div>
          )}
          {filteredPeople.length > 0 && (
            <div className="task-form-assignee-chips">
              {filteredPeople.slice(0, 24).map((p) => {
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
                    title={`${p.name} · ${p.role}`}
                    onClick={() => {
                      // Toggle: click once to append, click again to remove
                      // (matches the department chip row pattern above).
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
                    {p.name.split(/\s+/)[0]}
                  </button>
                );
              })}
            </div>
          )}
        </label>
      </div>

      {currentUserEmail && (
        <div className="task-form-author-line">
          כותב המשימה: <b dir="ltr">{currentUserEmail}</b>
        </div>
      )}

      <div className="task-form-actions">
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? "יוצר…" : "צור משימה"}
        </button>
      </div>
    </form>
  );
}
