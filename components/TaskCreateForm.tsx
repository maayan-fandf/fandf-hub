"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

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

type ProjectOption = { name: string; company: string };

export default function TaskCreateForm({
  projects,
  defaultProject,
}: {
  projects: ProjectOption[];
  defaultProject: string;
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

  const defaultCompany =
    projects.find((p) => p.name === defaultProject)?.company || "";

  const [company, setCompany] = useState(defaultCompany);
  const [project, setProject] = useState(defaultProject);
  const [departments, setDepartments] = useState<string[]>([]);

  // Projects available for the currently-selected company. Empty company
  // = show every project. Switching companies resets the project select
  // (the new list may not include the old selection).
  const companyProjects = company
    ? byCompany.get(company) || []
    : projects;

  function toggleDept(d: string) {
    setDepartments((cur) =>
      cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d],
    );
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const fd = new FormData(e.currentTarget);

    const assignees = String(fd.get("assignees") || "")
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
      approver_email: String(fd.get("approver_email") || ""),
      project_manager_email: String(fd.get("project_manager_email") || ""),
      assignees,
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

      <div className="task-form-row">
        <label>
          חברה
          <select
            value={company}
            onChange={(e) => {
              setCompany(e.target.value);
              setProject(""); // reset — project list changes with company
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
            onChange={(e) => {
              setProject(e.target.value);
              // Auto-fill company if user picks the project first.
              if (!company) {
                const p = projects.find((x) => x.name === e.target.value);
                if (p?.company) setCompany(p.company);
              }
            }}
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
          גורם מאשר (מייל או שם)
          <input
            type="text"
            name="approver_email"
            placeholder="name@fandf.co.il"
          />
        </label>

        <label>
          מנהל פרויקט (מייל או שם)
          <input
            type="text"
            name="project_manager_email"
            placeholder="name@fandf.co.il"
          />
        </label>

        <label>
          עובדים במשימה (פסיקים או שורות)
          <textarea
            name="assignees"
            rows={2}
            placeholder="felix@fandf.co.il, nadav@fandf.co.il"
          />
        </label>
      </div>

      <div className="task-form-actions">
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? "יוצר…" : "צור משימה"}
        </button>
      </div>
    </form>
  );
}
