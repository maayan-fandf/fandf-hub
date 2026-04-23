"use client";

import { useState } from "react";
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

export default function TaskCreateForm({
  projects,
  defaultProject,
}: {
  projects: string[];
  defaultProject: string;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const fd = new FormData(e.currentTarget);

    // Assignees comes in as a comma/newline separated string. The API also
    // accepts plain names that resolve via names→emails server-side.
    const assignees = String(fd.get("assignees") || "")
      .split(/[,;\n]/)
      .map((s) => s.trim())
      .filter(Boolean);

    const payload = {
      project: String(fd.get("project") || ""),
      title: String(fd.get("title") || ""),
      description: String(fd.get("description") || ""),
      department: String(fd.get("department") || ""),
      kind: String(fd.get("kind") || ""),
      priority: Number(fd.get("priority") || "2"),
      approver_email: String(fd.get("approver_email") || ""),
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

  return (
    <form className="task-form" onSubmit={onSubmit}>
      {error && <div className="error">{error}</div>}

      <label>
        פרויקט
        <select name="project" required defaultValue={defaultProject}>
          <option value="">בחר פרויקט…</option>
          {projects.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>

      <label>
        כותרת
        <input
          type="text"
          name="title"
          required
          placeholder="לדוגמה: בניית דף נחיתה — גינדי כפר אז״ר"
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

      <div className="task-form-row">
        <label>
          מחלקה
          <select name="department">
            <option value="">—</option>
            {DEPARTMENTS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>

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
      </div>

      <div className="task-form-row">
        <label>
          תאריך מבוקש
          <input type="date" name="requested_date" />
        </label>

        <label>
          גורם מאשר (מייל או שם)
          <input
            type="text"
            name="approver_email"
            placeholder="name@fandf.co.il"
          />
        </label>
      </div>

      <label>
        עובדים במשימה (פסיקים או שורות)
        <textarea
          name="assignees"
          rows={2}
          placeholder="felix@fandf.co.il, nadav@fandf.co.il"
        />
      </label>

      <div className="task-form-actions">
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? "יוצר…" : "צור משימה"}
        </button>
      </div>
    </form>
  );
}
