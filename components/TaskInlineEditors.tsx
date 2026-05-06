"use client";

import { useState } from "react";
import type { WorkTask, TasksPerson } from "@/lib/appsScript";
import InlineEditCell from "@/components/InlineEditCell";
import DatePicker from "@/components/DatePicker";
import TimePicker from "@/components/TimePicker";
import { displayNameOf, personDisplayName } from "@/lib/personDisplay";
import Avatar, { avatarHoverText } from "@/components/Avatar";

/** Find a TasksPerson row by email (case-insensitive). Used by the
 *  cell components to enrich the avatar tooltip with the role. */
function lookupPerson(
  email: string,
  people: TasksPerson[],
): TasksPerson | undefined {
  if (!email) return undefined;
  const needle = email.toLowerCase();
  return people.find((p) => p.email.toLowerCase() === needle);
}

// router.refresh() was silently no-op'ing on /tasks in production even
// with `export const dynamic = "force-dynamic"` on the page, leaving
// users staring at stale UI after a successful save. Hard reload is
// the reliable fallback — small page flash for guaranteed correctness.
function refreshPageAfterSave() {
  window.location.reload();
}

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
  // `pendingPriority` is the user's new pick — reflected in the trigger
  // pill the moment they click, so the cell feels instant. On successful
  // save we hard-reload, which re-mounts with the fresh value; on error
  // we revert and surface the message.
  const [pendingPriority, setPendingPriority] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const displayedPriority = pendingPriority ?? task.priority;
  const isPending = pendingPriority !== null;

  return (
    <InlineEditCell
      title={isPending ? "מעדכן…" : "לחץ לשינוי דחיפות"}
      minWidth={10}
      display={
        <span
          className={`tasks-priority-pill p${displayedPriority}${isPending ? " is-pending" : ""}`}
        >
          {displayedPriority || "—"}
          {isPending && (
            <span className="tasks-status-cell-spinner" aria-hidden>
              ⏳
            </span>
          )}
        </span>
      }
    >
      {(close) => (
        <div className="inline-edit-body">
          <div className="inline-edit-label">דחיפות</div>
          <div className="inline-edit-priority-row">
            {[1, 2, 3].map((p) => (
              <button
                key={p}
                type="button"
                disabled={isPending}
                className={`tasks-priority-pill p${p}${
                  p === task.priority ? " is-active" : ""
                }`}
                onClick={async () => {
                  if (p === task.priority) return close();
                  // OPTIMISTIC: flip the trigger pill immediately + close
                  // the popover so the cell reflects the user's intent
                  // before the ~2–10 s server fanout completes.
                  setPendingPriority(p);
                  setErr(null);
                  close();
                  const errMsg = await postTaskUpdate(task.id, {
                    priority: p,
                  });
                  if (errMsg) {
                    setPendingPriority(null);
                    setErr(errMsg);
                  } else {
                    refreshPageAfterSave();
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

/** Overdue test for the date cell — same semantics as the queue's
 *  isOverdue helper, scoped to here so this component stays
 *  self-contained. Date-only "YYYY-MM-DD" treats end-of-day as the
 *  due moment so a task due "today" doesn't flicker overdue all day;
 *  a value with an explicit time portion uses that exact moment.
 *  Done / cancelled tasks never read overdue regardless of the date. */
function isCellOverdue(task: WorkTask): boolean {
  if (!task.requested_date) return false;
  if (task.status === "done" || task.status === "cancelled") return false;
  const raw = task.requested_date.trim();
  const ms = raw.length <= 10 ? Date.parse(`${raw}T23:59:59`) : Date.parse(raw);
  if (!Number.isFinite(ms)) return false;
  return ms < Date.now();
}

export function TaskRequestedDateCell({ task }: { task: WorkTask }) {
  // requested_date can be "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM" — split
  // for editing, recombine on save.
  const initialRaw = task.requested_date || "";
  const initialDate = initialRaw.match(/^\d{4}-\d{2}-\d{2}/)?.[0] || "";
  const initialTime = initialRaw.match(/[T\s](\d{2}:\d{2})/)?.[1] || "";
  const [date, setDate] = useState(initialDate);
  const [time, setTime] = useState(initialTime);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const overdue = isCellOverdue(task);

  return (
    <InlineEditCell
      title={
        overdue
          ? "תאריך היעד עבר — לחץ לעדכון"
          : "לחץ לשינוי תאריך מבוקש"
      }
      minWidth={14}
      display={
        <span className={overdue ? "task-date-overdue" : undefined}>
          {overdue && <span aria-hidden>⚠️ </span>}
          {initialDate || "—"}
          {initialTime && (
            <span className="task-time-chip"> · {initialTime}</span>
          )}
        </span>
      }
    >
      {(close) => (
        <div className="inline-edit-body">
          <div className="inline-edit-label">תאריך מבוקש</div>
          <div className="inline-edit-date-time">
            <DatePicker
              value={date}
              onChange={setDate}
              disabled={busy}
              className="inline-edit-input"
            />
            <TimePicker
              value={time}
              onChange={setTime}
              disabled={busy}
              ariaLabel="שעה (אופציונלי)"
            />
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
                const combined = date && time ? `${date}T${time}` : date;
                if (combined === task.requested_date) return close();
                setBusy(true);
                setErr(null);
                const errMsg = await postTaskUpdate(task.id, {
                  requested_date: combined,
                });
                setBusy(false);
                if (errMsg) setErr(errMsg);
                else {
                  close();
                  refreshPageAfterSave();
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
  const [value, setValue] = useState(task.approver_email || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const approverPerson = lookupPerson(task.approver_email || "", people);
  const approverName =
    personDisplayName(task.approver_email, people) || task.approver_email;
  return (
    <InlineEditCell
      title="לחץ לשינוי גורם מאשר"
      minWidth={18}
      display={
        task.approver_email ? (
          <span
            className="cell-person"
            title={avatarHoverText(
              approverName,
              task.approver_email,
              approverPerson?.role,
            )}
          >
            <Avatar
              name={task.approver_email}
              role={approverPerson?.role}
              title={approverName}
              size={18}
            />
            <span className="cell-person-name">{approverName}</span>
          </span>
        ) : (
          <span>—</span>
        )
      }
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
                {displayNameOf(p)} · {p.role}
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
                  refreshPageAfterSave();
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
  const [list, setList] = useState<string[]>(task.assignees || []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const currentAssignees = task.assignees || [];
  return (
    <InlineEditCell
      title="לחץ לשינוי עובדים במשימה"
      minWidth={22}
      display={
        currentAssignees.length === 0 ? (
          <span>—</span>
        ) : (
          <span className="cell-people-list">
            {currentAssignees.map((email) => {
              const person = lookupPerson(email, people);
              const name = personDisplayName(email, people) || email;
              return (
                <span
                  key={email}
                  className="cell-person"
                  title={avatarHoverText(name, email, person?.role)}
                >
                  <Avatar
                    name={email}
                    role={person?.role}
                    title={name}
                    size={18}
                  />
                  <span className="cell-person-name">{name}</span>
                </span>
              );
            })}
          </span>
        )
      }
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
                  title={`${displayNameOf(p)} · ${p.role}`}
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
                  {displayNameOf(p)}
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
                  refreshPageAfterSave();
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

