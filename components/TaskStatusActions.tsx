"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { WorkTask, WorkTaskStatus } from "@/lib/appsScript";

// Mirror of Apps Script TASKS_ALLOWED_TRANSITIONS — kept in sync so the UI
// only offers transitions the server will accept. If they diverge the
// server will reject; the client just won't surface the button.
const TRANSITIONS: Record<WorkTaskStatus, { to: WorkTaskStatus; label: string; tone: string }[]> = {
  draft: [
    { to: "awaiting_handling", label: "שלח למבצע", tone: "primary" },
    { to: "cancelled", label: "בטל", tone: "ghost" },
  ],
  awaiting_handling: [
    { to: "in_progress", label: "✓ התחל לעבוד", tone: "primary" },
    { to: "cancelled", label: "בטל", tone: "ghost" },
  ],
  in_progress: [
    { to: "awaiting_approval", label: "✓ סיימתי — שלח לאישור", tone: "primary" },
    { to: "awaiting_clarification", label: "? צריך בירור", tone: "warn" },
    { to: "cancelled", label: "בטל", tone: "ghost" },
  ],
  awaiting_clarification: [
    { to: "in_progress", label: "✓ סיום בירור — חזור לעבודה", tone: "primary" },
    { to: "awaiting_handling", label: "→ חזרה לטיפול", tone: "ghost" },
    { to: "cancelled", label: "בטל", tone: "ghost" },
  ],
  awaiting_approval: [
    { to: "done", label: "✓ אשר — בוצע", tone: "primary" },
    { to: "in_progress", label: "↺ החזר לעבודה", tone: "warn" },
    { to: "cancelled", label: "דחה", tone: "ghost" },
  ],
  done: [
    { to: "in_progress", label: "פתח מחדש", tone: "ghost" },
  ],
  cancelled: [],
};

export default function TaskStatusActions({ task }: { task: WorkTask }) {
  const router = useRouter();
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const options = TRANSITIONS[task.status] || [];
  if (options.length === 0) return null;

  async function transition(to: WorkTaskStatus, label: string) {
    const note = window.prompt(`הערה (אופציונלי) עבור "${label}":`, "");
    if (note === null) return; // user cancelled the prompt
    setSaving(to);
    setError(null);
    try {
      const res = await fetch("/api/worktasks/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: task.id,
          patch: { status: to, note: note || "" },
        }),
      });
      const data = (await res.json()) as
        | { ok: true }
        | { ok: false; error: string };
      if (!res.ok || !data.ok) {
        throw new Error("error" in data ? data.error : "Failed to update");
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className="task-actions">
      <h3>פעולות</h3>
      <div className="task-actions-row">
        {options.map((opt) => (
          <button
            key={opt.to}
            type="button"
            className={`btn-${opt.tone}`}
            disabled={saving !== null}
            onClick={() => transition(opt.to, opt.label)}
          >
            {saving === opt.to ? "…" : opt.label}
          </button>
        ))}
      </div>
      {error && <div className="error">{error}</div>}
    </section>
  );
}
