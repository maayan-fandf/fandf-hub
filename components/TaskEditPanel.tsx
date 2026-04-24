"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { TasksPerson, WorkTask } from "@/lib/appsScript";

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
// Known sub_status values from the Data Plus screenshot. Free-form text
// still wins — the select has an "(אחר)" option that reveals a text
// input so uncommon labels remain entrable.
const SUB_STATUSES = ["", "אושר", "ממתין לטיפול"];

export default function TaskEditPanel({
  task,
  people,
}: {
  task: WorkTask;
  people: TasksPerson[];
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState(task.title || "");
  const [description, setDescription] = useState(task.description || "");
  const [brief, setBrief] = useState(task.brief || "");
  const [departments, setDepartments] = useState<string[]>(
    task.departments || [],
  );
  const [kind, setKind] = useState(task.kind || "other");
  const [priority, setPriority] = useState(String(task.priority || 2));
  const [requestedDate, setRequestedDate] = useState(task.requested_date || "");
  const [approver, setApprover] = useState(task.approver_email || "");
  const [projectManager, setProjectManager] = useState(
    task.project_manager_email || "",
  );
  const [assignees, setAssignees] = useState(
    (task.assignees || []).join(", "),
  );
  const [subStatusSelect, setSubStatusSelect] = useState(
    SUB_STATUSES.includes(task.sub_status) ? task.sub_status : "__custom__",
  );
  const [subStatusCustom, setSubStatusCustom] = useState(
    SUB_STATUSES.includes(task.sub_status) ? "" : task.sub_status,
  );
  const [campaign, setCampaign] = useState(task.campaign || "");
  const [campaignOptions, setCampaignOptions] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/tasks/campaigns?project=${encodeURIComponent(task.project)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        setCampaignOptions((data?.campaigns ?? []) as string[]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [task.project]);

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

    const subStatus =
      subStatusSelect === "__custom__" ? subStatusCustom : subStatusSelect;

    const patch = {
      title,
      description,
      brief,
      departments,
      kind,
      priority: Number(priority),
      requested_date: requestedDate,
      approver_email: approver,
      project_manager_email: projectManager,
      assignees: assigneeList,
      sub_status: subStatus,
      campaign: campaign.trim(),
    };

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
          פרויקט + חברה אינם ניתנים לעריכה (מחייבים יצירה מחדש של התיקייה
          ב־Drive).
        </p>
      </div>

      {error && <div className="error">{error}</div>}

      <datalist id="tasks-people-edit">
        {people.map((p) => (
          <option key={p.email} value={p.email}>
            {p.name} · {p.role}
          </option>
        ))}
      </datalist>

      <div className="task-form-row">
        <label>
          פרויקט (קבוע)
          <input type="text" value={task.project} disabled readOnly />
        </label>
        <label>
          חברה (קבוע)
          <input
            type="text"
            value={task.company || "—"}
            disabled
            readOnly
          />
        </label>
        <label>
          בריף
          <input
            type="text"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="10431"
          />
        </label>
      </div>

      <div className="task-form-row">
        <label>
          קמפיין
          <input
            type="text"
            list="task-campaigns-edit"
            value={campaign}
            onChange={(e) => setCampaign(e.target.value)}
            placeholder="בחר קמפיין קיים או הקלד חדש"
          />
        </label>
      </div>
      <datalist id="task-campaigns-edit">
        {campaignOptions.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>

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
          עדיפות
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          >
            <option value="1">1 — גבוהה</option>
            <option value="2">2 — רגילה</option>
            <option value="3">3 — נמוכה</option>
          </select>
        </label>

        <label>
          תאריך מבוקש
          <input
            type="date"
            value={requestedDate}
            onChange={(e) => setRequestedDate(e.target.value)}
          />
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

        <label>
          סטטוס משני
          <select
            value={subStatusSelect}
            onChange={(e) => setSubStatusSelect(e.target.value)}
          >
            <option value="">—</option>
            <option value="אושר">אושר</option>
            <option value="ממתין לטיפול">ממתין לטיפול</option>
            <option value="__custom__">(אחר)</option>
          </select>
          {subStatusSelect === "__custom__" && (
            <input
              type="text"
              value={subStatusCustom}
              onChange={(e) => setSubStatusCustom(e.target.value)}
              placeholder="טקסט חופשי"
              style={{ marginTop: ".4em" }}
            />
          )}
        </label>
      </div>

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
