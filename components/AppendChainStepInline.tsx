"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Inline form rendered at the bottom of the umbrella detail page's
 * children list — lets the user append a new step to the chain
 * without going through the full create-task flow.
 *
 * Collapsed state: a single "+ הוסף שלב" button.
 * Expanded state: title input + assignees input + submit/cancel.
 *
 * On success, calls router.refresh() to re-fetch the umbrella's
 * children and re-render the list with the new step at the end.
 *
 * Phase 9 of dependencies feature, 2026-05-03.
 */
export default function AppendChainStepInline({
  umbrellaId,
}: {
  umbrellaId: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [assignees, setAssignees] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setTitle("");
    setAssignees("");
    setError(null);
    setOpen(false);
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!title.trim()) {
      setError("כותרת חובה");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const assigneeList = assignees
        .split(/[,;\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await fetch("/api/worktasks/append-chain-step", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          umbrellaId,
          title: title.trim(),
          assignees: assigneeList,
        }),
      });
      const data = (await res.json()) as
        | { ok: true; step: { id: string }; appendedAfter: string | null }
        | { ok: false; error: string };
      if (!res.ok || !data.ok) {
        throw new Error("error" in data ? data.error : "Failed to append step");
      }
      reset();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <div className="umbrella-append-step-collapsed">
        <button
          type="button"
          className="btn-ghost btn-sm"
          onClick={() => setOpen(true)}
        >
          + הוסף שלב
        </button>
      </div>
    );
  }

  return (
    <form className="umbrella-append-step-form" onSubmit={onSubmit}>
      {error && <div className="error">{error}</div>}
      <div className="umbrella-append-step-row">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="כותרת השלב החדש"
          autoFocus
          required
          className="umbrella-append-step-title"
        />
        <input
          type="text"
          value={assignees}
          onChange={(e) => setAssignees(e.target.value)}
          placeholder="מבצע — name@fandf.co.il (אופציונלי)"
          className="umbrella-append-step-assignee"
        />
      </div>
      <div className="umbrella-append-step-actions">
        <button type="submit" className="btn-primary btn-sm" disabled={saving}>
          {saving ? "מוסיף…" : "הוסף שלב"}
        </button>
        <button
          type="button"
          className="btn-ghost btn-sm"
          onClick={reset}
          disabled={saving}
        >
          ביטול
        </button>
        <span className="umbrella-append-step-hint">
          השלב מתווסף בסוף השרשרת — מתחיל אוטומטית כשהשלב הקודם בוצע
        </span>
      </div>
    </form>
  );
}
