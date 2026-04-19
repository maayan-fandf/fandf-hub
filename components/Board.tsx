"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { TaskItem } from "@/lib/appsScript";

type Props = {
  tasks: TaskItem[];
  today: string;
  assigneeFilter: string; // "" = all
  showDone: boolean;
};

export default function Board({ tasks, today, assigneeFilter, showDone }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [dragSrc, setDragSrc] = useState<{ commentId: string; from: string } | null>(
    null,
  );
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Filter tasks per current UI state (filters apply on top of server-fetched data).
  const visible = tasks.filter((t) => {
    if (!showDone && t.resolved) return false;
    if (assigneeFilter && t.assignee_email.toLowerCase() !== assigneeFilter.toLowerCase()) {
      return false;
    }
    return true;
  });

  // Group by assignee.
  const byAssignee = new Map<string, TaskItem[]>();
  for (const t of visible) {
    const key = t.assignee_email || "(unassigned)";
    if (!byAssignee.has(key)) byAssignee.set(key, []);
    byAssignee.get(key)!.push(t);
  }
  const columns = Array.from(byAssignee.entries()).sort((a, b) => {
    const openA = a[1].filter((t) => !t.resolved).length;
    const openB = b[1].filter((t) => !t.resolved).length;
    if (openA !== openB) return openB - openA;
    return a[0].localeCompare(b[0]);
  });

  async function handleDrop(toEmail: string) {
    const src = dragSrc;
    setDragSrc(null);
    setDropTarget(null);
    if (!src) return;
    if (src.from.toLowerCase() === toEmail.toLowerCase()) return;
    setError(null);
    setBusyKey(src.commentId + "|" + src.from);
    try {
      const res = await fetch("/api/tasks/reassign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commentId: src.commentId,
          fromEmail: src.from,
          toEmail,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleDueChange(
    task: TaskItem,
    newDue: string,
  ): Promise<void> {
    setError(null);
    setBusyKey(task.comment_id + "|" + task.assignee_email);
    try {
      const res = await fetch("/api/tasks/due", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commentId: task.comment_id,
          assigneeEmail: task.assignee_email,
          due: newDue,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <>
      {error && (
        <div className="error" style={{ marginBottom: "1rem" }}>
          {error}
        </div>
      )}
      <div className="board">
        {columns.map(([email, items]) => {
          const name =
            items[0]?.assignee_name || email.split("@")[0] || "(unassigned)";
          const openCount = items.filter((t) => !t.resolved).length;
          const isDropZone = dropTarget === email;
          return (
            <section
              key={email}
              className={`board-column ${isDropZone ? "is-drop-target" : ""}`}
              onDragOver={(e) => {
                if (dragSrc && dragSrc.from.toLowerCase() !== email.toLowerCase()) {
                  e.preventDefault();
                  setDropTarget(email);
                }
              }}
              onDragLeave={(e) => {
                if (e.currentTarget === e.target) setDropTarget(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                handleDrop(email);
              }}
            >
              <h3>
                {name} <span className="count">{openCount}</span>
              </h3>
              <ul className="task-list">
                {items.map((t) => (
                  <TaskCard
                    key={t.comment_id + "|" + email}
                    task={t}
                    today={today}
                    busy={busyKey === t.comment_id + "|" + t.assignee_email || pending}
                    onDragStart={() =>
                      setDragSrc({ commentId: t.comment_id, from: t.assignee_email })
                    }
                    onDueChange={(d) => handleDueChange(t, d)}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </>
  );
}

function TaskCard({
  task,
  today,
  busy,
  onDragStart,
  onDueChange,
}: {
  task: TaskItem;
  today: string;
  busy: boolean;
  onDragStart: () => void;
  onDueChange: (d: string) => void;
}) {
  const state = taskState(task, today);
  const [editing, setEditing] = useState(false);
  const [dueDraft, setDueDraft] = useState(task.due);

  return (
    <li
      className={`task-card ${state} ${busy ? "is-busy" : ""}`}
      draggable={!task.resolved}
      onDragStart={onDragStart}
    >
      <div className="task-row">
        <div className="task-title">
          {task.deep_link ? (
            <a href={task.deep_link} target="_blank" rel="noreferrer">
              {task.title || "(no body)"}
            </a>
          ) : (
            task.title || "(no body)"
          )}
        </div>
      </div>
      <div className="task-meta">
        {editing ? (
          <span className="due-editor">
            <input
              type="date"
              value={dueDraft}
              onChange={(e) => setDueDraft(e.target.value)}
              autoFocus
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                if (dueDraft !== task.due) onDueChange(dueDraft);
              }}
            >
              Save
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setDueDraft(task.due);
              }}
            >
              Cancel
            </button>
            {task.due && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setEditing(false);
                  onDueChange("");
                }}
                title="Clear due date"
              >
                Clear
              </button>
            )}
          </span>
        ) : (
          <button
            type="button"
            className={`task-due btn-link ${state}`}
            onClick={() => {
              setDueDraft(task.due);
              setEditing(true);
            }}
            disabled={busy || task.resolved}
            title="Click to edit due date"
          >
            {task.due ? formatDue(task.due, today) : "+ due date"}
          </button>
        )}
        <span className="by">by {task.author_name || task.author_email}</span>
        {task.resolved && <span>· done</span>}
      </div>
    </li>
  );
}

function taskState(
  t: TaskItem,
  today: string,
): "done" | "overdue" | "due-today" | "" {
  if (t.resolved) return "done";
  if (!t.due) return "";
  if (t.due < today) return "overdue";
  if (t.due === today) return "due-today";
  return "";
}

function formatDue(due: string, today: string): string {
  if (due === today) return "Due today";
  if (due < today) return `Overdue (${due})`;
  return `Due ${due}`;
}
