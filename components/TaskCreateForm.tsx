"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { TasksPerson } from "@/lib/appsScript";

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
  people,
  currentUserEmail,
}: {
  projects: ProjectOption[];
  defaultProject: string;
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
  const defaultCompany = defaultProjectOpt?.company || "";
  const defaultPm = defaultProjectOpt
    ? nameToEmail.get(defaultProjectOpt.projectManagerFull.trim().toLowerCase()) || ""
    : "";

  const [company, setCompany] = useState(defaultCompany);
  const [project, setProject] = useState(defaultProject);
  const [departments, setDepartments] = useState<string[]>([]);
  const [projectManager, setProjectManager] = useState(defaultPm);
  const [approver, setApprover] = useState("");
  const [assignees, setAssignees] = useState("");

  const companyProjects = company ? byCompany.get(company) || [] : projects;

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

    const payload = {
      project: project,
      company: company, // falls back to Keys lookup server-side if empty
      brief: String(fd.get("brief") || ""),
      title: String(fd.get("title") || ""),
      description: String(fd.get("description") || ""),
      departments,
      kind: String(fd.get("kind") || ""),
      priority: Number(fd.get("priority") || "2"),
      approver_email: approver,
      project_manager_email: projectManager,
      assignees: assigneeList,
      requested_date: String(fd.get("requested_date") || ""),
    };

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

      {/* Shared datalist for all four people inputs below. */}
      <datalist id="tasks-people">
        {people.map((p) => (
          <option key={p.email} value={p.email}>
            {p.name} · {p.role}
          </option>
        ))}
      </datalist>

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
          בריף
          <input
            type="text"
            name="brief"
            placeholder="10431"
            inputMode="text"
          />
        </label>
      </div>

      <label>
        כותרת
        <input
          type="text"
          name="title"
          required
          placeholder="לדוגמה: Minisite_desktop — דף נחיתה לקמפיין כפר אז״ר"
        />
      </label>

      <label>
        תיאור
        <textarea
          name="description"
          rows={5}
          placeholder="מה צריך לעשות, מה הקונטקסט, קישורים רלוונטיים…"
        />
      </label>

      <label>
        מחלקות (ניתן לבחור יותר מאחת, כמו ב־Data Plus)
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
          <select name="kind" defaultValue="ad_creative">
            {KINDS.map((k) => (
              <option key={k.val} value={k.val}>
                {k.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          עדיפות
          <select name="priority" defaultValue="2">
            <option value="1">1 — גבוהה</option>
            <option value="2">2 — רגילה</option>
            <option value="3">3 — נמוכה</option>
          </select>
        </label>

        <label>
          תאריך מבוקש
          <input type="date" name="requested_date" />
        </label>
      </div>

      <div className="task-form-row">
        <label>
          גורם מאשר
          <input
            type="text"
            list="tasks-people"
            value={approver}
            onChange={(e) => setApprover(e.target.value)}
            placeholder="name@fandf.co.il"
          />
        </label>

        <label>
          מנהל פרויקט
          <input
            type="text"
            list="tasks-people"
            value={projectManager}
            onChange={(e) => setProjectManager(e.target.value)}
            placeholder="name@fandf.co.il"
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
