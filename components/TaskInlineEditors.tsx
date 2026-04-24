"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { WorkTask, TasksPerson } from "@/lib/appsScript";
import InlineEditCell from "@/components/InlineEditCell";

/**
 * Shared POST helper. All four editors call the same update endpoint
 * with a small patch; keeps error handling + router.refresh in one
 * place. Returns null on success or an error message string.
 */
async function postTaskUpdate(
  id: string,
  patch: Record<string, unknown>,
): Promise<string | null> {
  try {
    const res = await fetch("/api/worktasks/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, patch }),
    });
    const data = (await res.json()) as
      | { ok: true }
      | { ok: false; error: string };
    if (!res.ok || !data.ok) {
      return "error" in data ? data.error : "Update failed";
    }
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/* ── Priority (1 / 2 / 3) ──────────────────────────────────────────── */

export function TaskPriorityCell({ task }: { task: WorkTask }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <InlineEditCell
      title="לחץ לשינוי עדיפות"
      minWidth={10}
      display={
        <span className={`tasks-priority-pill p${task.priority}`}>
          {task.priority || "—"}
        </span>
      }
    >
      {(close) => (
        <div className="inline-edit-body">
          <div className="inline-edit-label">עדיפות</div>
          <div className="inline-edit-priority-row">
            {[1, 2, 3].map((p) => (
              <button
                key={p}
                type="button"
                disabled={busy}
                className={`tasks-priority-pill p${p}${
                  p === task.priority ? " is-active" : ""
                }`}
                onClick={async () => {
                  if (p === task.priority) return close();
                  setBusy(true);
                  setErr(null);
                  const errMsg = await postTaskUpdate(task.id, {
                    priority: p,
                  });
                  setBusy(false);
                  if (errMsg) setErr(errMsg);
                  else {
                    close();
                    router.refresh();
                  }
                }}
              >
                {p}
              </button>
            ))}
          </div>
          {err && <div className="inline-edit-err">{err}</div>}
        </div>
      )}
    </InlineEditCell>
  );
}

/* ── Requested date ────────────────────────────────────────────────── */

export function TaskRequestedDateCell({ task }: { task: WorkTask }) {
  const router = useRouter();
  const [value, setValue] = useState(task.requested_date || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <InlineEditCell
      title="לחץ לשינוי תאריך מבוקש"
      minWidth={14}
      display={<span>{task.requested_date || "—"}</span>}
    >
      {(close) => (
        <div className="inline-edit-body">
          <div className="inline-edit-label">תאריך מבוקש</div>
          <input
            type="date"
            className="inline-edit-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={busy}
            autoFocus
          />
          <div className="inline-edit-actions">
            <button
              type="button"
              className="btn-ghost"
              disabled={busy}
              onClick={() => close()}
            >
              בטל
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={async () => {
                if (value === task.requested_date) return close();
                setBusy(true);
                setErr(null);
                const errMsg = await postTaskUpdate(task.id, {
                  requested_date: value,
                });
                setBusy(false);
                if (errMsg) setErr(errMsg);
                else {
                  close();
                  router.refresh();
                }
              }}
            >
              {busy ? "…" : "שמור"}
            </button>
          </div>
          {err && <div className="inline-edit-err">{err}</div>}
        </div>
      )}
    </InlineEditCell>
  );
}

/* ── Approver (people picker) ──────────────────────────────────────── */

export function TaskApproverCell({
  task,
  people,
}: {
  task: WorkTask;
  people: TasksPerson[];
}) {
  const router = useRouter();
  const [value, setValue] = useState(task.approver_email || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <InlineEditCell
      title="לחץ לשינוי גורם מאשר"
      minWidth={18}
      display={<span>{shortName(task.approver_email) || "—"}</span>}
    >
      {(close) => (
        <div className="inline-edit-body">
          <div className="inline-edit-label">גורם מאשר</div>
          <input
            type="text"
            list="tasks-people-inline"
            className="inline-edit-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={busy}
            autoFocus
            placeholder="name@fandf.co.il"
          />
          <datalist id="tasks-people-inline">
            {people.map((p) => (
              <option key={p.email} value={p.email}>
                {p.name} · {p.role}
              </option>
            ))}
          </datalist>
          <div className="inline-edit-actions">
            <button
              type="button"
              className="btn-ghost"
              disabled={busy}
              onClick={() => close()}
            >
              בטל
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={async () => {
                if (value === task.approver_email) return close();
                setBusy(true);
                setErr(null);
                const errMsg = await postTaskUpdate(task.id, {
                  approver_email: value,
                });
                setBusy(false);
                if (errMsg) setErr(errMsg);
                else {
                  close();
                  router.refresh();
                }
              }}
            >
              {busy ? "…" : "שמור"}
            </button>
          </div>
          {err && <div className="inline-edit-err">{err}</div>}
        </div>
      )}
    </InlineEditCell>
  );
}

/* ── Assignees (chip picker) ───────────────────────────────────────── */

export function TaskAssigneesCell({
  task,
  people,
}: {
  task: WorkTask;
  people: TasksPerson[];
}) {
  const router = useRouter();
  const [list, setList] = useState<string[]>(task.assignees || []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const currentDisplay = (task.assignees || []).map(shortName).join(", ") || "—";

  return (
    <InlineEditCell
      title="לחץ לשינוי עובדים במשימה"
      minWidth={22}
      display={<span>{currentDisplay}</span>}
    >
      {(close) => (
        <div className="inline-edit-body">
          <div className="inline-edit-label">עובדים במשימה</div>
          <div className="inline-edit-chips">
            {people.slice(0, 24).map((p) => {
              const on = list.map((e) => e.toLowerCase()).includes(
                p.email.toLowerCase(),
              );
              return (
                <button
                  key={p.email}
                  type="button"
                  className={`task-form-assignee-chip${on ? " is-active" : ""}`}
                  disabled={busy}
                  title={`${p.name} · ${p.role}`}
                  onClick={() =>
                    setList((cur) =>
                      on
                        ? cur.filter(
                            (e) => e.toLowerCase() !== p.email.toLowerCase(),
                          )
                        : [...cur, p.email],
                    )
                  }
                >
                  {p.name.split(/\s+/)[0]}
                </button>
              );
            })}
          </div>
          <div className="inline-edit-actions">
            <button
              type="button"
              className="btn-ghost"
              disabled={busy}
              onClick={() => close()}
            >
              בטל
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={async () => {
                const changed =
                  list.join(",") !== (task.assignees || []).join(",");
                if (!changed) return close();
                setBusy(true);
                setErr(null);
                const errMsg = await postTaskUpdate(task.id, {
                  assignees: list,
                });
                setBusy(false);
                if (errMsg) setErr(errMsg);
                else {
                  close();
                  router.refresh();
                }
              }}
            >
              {busy ? "…" : "שמור"}
            </button>
          </div>
          {err && <div className="inline-edit-err">{err}</div>}
        </div>
      )}
    </InlineEditCell>
  );
}

/* ── Shared ────────────────────────────────────────────────────────── */

function shortName(email: string): string {
  if (!email) return "";
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}
