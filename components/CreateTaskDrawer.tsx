"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Assignee } from "@/lib/appsScript";
import Avatar from "./Avatar";
import RoleChip from "./RoleChip";

type Props = {
  project: string;
};

const MAX = 4000;

type PickerState = {
  // Position in the textarea value where the `@` lives. -1 = picker closed.
  queryStart: number;
  // Text typed after the `@` so far.
  query: string;
  // Keyboard-highlighted result index.
  index: number;
  // Viewport coords — dropdown is position:fixed so it escapes the modal
  // overflow clipping and survives scroll.
  top: number;
  left: number;
};

const CLOSED_PICKER: PickerState = { queryStart: -1, query: "", index: 0, top: 0, left: 0 };

/**
 * "+ New task" entry point on a project page. Opens a modal with:
 *   - body textarea with inline @-mention autocomplete (type `@` → picker
 *     pops up above the textarea, arrow-keys + Enter/Tab to select)
 *   - optional due date
 *
 * The @-mention flow mirrors the dashboard's comment drawer: the user types
 * `@` followed by a name fragment, picks from the dropdown, and the body
 * gains literal `@<name> ` text. Mentioned emails are tracked in a Set and
 * re-verified at submit time (if the user deleted a pill's text, that
 * mention is dropped). Submitting goes through /api/tasks/create — same
 * sheet-append + Google Tasks dispatch path as a dashboard comment.
 */
export default function CreateTaskDrawer({ project }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [due, setDue] = useState("");
  const [mentionedEmails, setMentionedEmails] = useState<Set<string>>(new Set());
  const [assignees, setAssignees] = useState<Assignee[] | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [picker, setPicker] = useState<PickerState>(CLOSED_PICKER);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Lazy-fetch assignees the first time the drawer opens.
  useEffect(() => {
    if (!open || assignees !== null || loading) return;
    setLoading(true);
    setFetchError(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/projects/assignees?project=${encodeURIComponent(project)}`,
        );
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || `Request failed (${res.status})`);
        }
        const data = (await res.json()) as { assignees: Assignee[] };
        setAssignees(data.assignees);
      } catch (err) {
        setFetchError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [open, project, assignees, loading]);

  function openDrawer() {
    setOpen(true);
    setSubmitError(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function closeDrawer() {
    setOpen(false);
    setBody("");
    setDue("");
    setMentionedEmails(new Set());
    setPicker(CLOSED_PICKER);
    setSubmitError(null);
  }

  // Filter assignees against the current `@...` query. Matches name or
  // email, case-insensitive. Cap at 8 like the dashboard.
  const results = useMemo(() => {
    if (picker.queryStart < 0 || !assignees) return [];
    const q = picker.query.toLowerCase();
    return assignees
      .filter((a) => !q || a.name.toLowerCase().includes(q) || a.email.toLowerCase().includes(q))
      .slice(0, 8);
  }, [picker.queryStart, picker.query, assignees]);

  function openPickerAt(textarea: HTMLTextAreaElement, queryStart: number, query: string) {
    const rect = textarea.getBoundingClientRect();
    setPicker({
      queryStart,
      query,
      index: 0,
      // 8px gap above the textarea; dropdown itself uses transform:
      // translateY(-100%) in CSS so it grows upward from here.
      top: rect.top - 8,
      left: rect.left,
    });
  }

  function closePicker() {
    setPicker(CLOSED_PICKER);
  }

  function onBodyChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    setBody(value);
    updatePickerFromCursor(value, e.target);
  }

  // Walk backward from the cursor to the nearest `@` (or whitespace boundary).
  // Matches the dashboard's pattern exactly so the UX feels identical.
  function updatePickerFromCursor(value: string, textarea: HTMLTextAreaElement) {
    const pos = textarea.selectionStart;
    let i = pos - 1;
    let hasAt = false;
    while (i >= 0) {
      const ch = value[i];
      if (ch === "@") {
        hasAt = true;
        break;
      }
      if (/\s/.test(ch)) break;
      i--;
    }
    if (hasAt) {
      openPickerAt(textarea, i, value.slice(i + 1, pos));
    } else {
      closePicker();
    }
  }

  function applySelection(r: Assignee) {
    const ta = textareaRef.current;
    if (!ta) return;
    const cursor = ta.selectionEnd;
    const before = body.slice(0, picker.queryStart);
    const after = body.slice(cursor);
    const insert = "@" + r.name + " ";
    const newBody = before + insert + after;
    setBody(newBody);
    setMentionedEmails((prev) => {
      const next = new Set(prev);
      next.add(r.email);
      return next;
    });
    closePicker();
    // Move cursor to end of inserted text so typing continues naturally.
    requestAnimationFrame(() => {
      const newPos = (before + insert).length;
      ta.setSelectionRange(newPos, newPos);
      ta.focus();
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Picker-aware keys take priority when the dropdown is open.
    if (picker.queryStart >= 0 && results.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setPicker((p) => ({ ...p, index: Math.min(p.index + 1, results.length - 1) }));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setPicker((p) => ({ ...p, index: Math.max(p.index - 1, 0) }));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applySelection(results[picker.index]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closePicker();
        return;
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeDrawer();
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  }

  // Close the picker if the user clicks outside it (or the textarea).
  useEffect(() => {
    if (picker.queryStart < 0) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".mention-dropdown")) return;
      if (target === textareaRef.current) return;
      closePicker();
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [picker.queryStart]);

  // Re-verify at submit time: an email counts as "mentioned" only if its
  // `@<name>` pill text is still present in the body. Lets the user back-
  // space a pill to remove a mention without cluttering the API call.
  const finalMentions: string[] = useMemo(() => {
    if (!assignees) return [];
    const out: string[] = [];
    mentionedEmails.forEach((email) => {
      const r = assignees.find((a) => a.email === email);
      if (r && body.includes("@" + r.name)) out.push(email);
    });
    return out;
  }, [mentionedEmails, assignees, body]);

  function submit() {
    const trimmed = body.trim();
    if (!trimmed) {
      setSubmitError("תוכן המשימה לא יכול להיות ריק.");
      return;
    }
    if (trimmed.length > MAX) {
      setSubmitError(`ארוך מדי (${trimmed.length}/${MAX}).`);
      return;
    }
    setSubmitError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/tasks/create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            project,
            body: trimmed,
            assignees: finalMentions,
            due: due || "",
          }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || `Request failed (${res.status})`);
        }
        closeDrawer();
        router.refresh();
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        className="btn-ghost btn-sm"
        onClick={openDrawer}
        title="הוסף הערה עם תיוגים — נשלחת כ-Google Task לכל מתויג"
      >
        + הערה
      </button>
    );
  }

  const count = body.trim().length;
  const over = count > MAX;
  const pickerOpen = picker.queryStart >= 0 && results.length > 0;

  return (
    <div
      className="create-task-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeDrawer();
      }}
    >
      <div className="create-task-modal" role="dialog" aria-modal="true">
        <div className="create-task-head">
          <h2>משימה חדשה · {project}</h2>
          <button
            type="button"
            className="create-task-close"
            onClick={closeDrawer}
            aria-label="סגור"
          >
            ×
          </button>
        </div>

        <label className="create-task-label">
          תוכן <span className="create-task-hint">(הקלד @ לתיוג)</span>
          <textarea
            ref={textareaRef}
            className="reply-textarea"
            rows={5}
            value={body}
            onChange={onBodyChange}
            onKeyDown={onKeyDown}
            onKeyUp={(e) => updatePickerFromCursor(body, e.currentTarget)}
            onClick={(e) => updatePickerFromCursor(body, e.currentTarget)}
            placeholder="מה צריך לעשות? הקלד @ לתיוג אדם (⌘/Ctrl+Enter ליצירה)"
            disabled={isPending}
            maxLength={MAX + 1}
          />
          <div className="create-task-body-foot">
            {finalMentions.length > 0 && (
              <span className="create-task-mentions-hint">
                תויגו: {finalMentions.length}
              </span>
            )}
            <span className={`reply-count ${over ? "is-over" : ""}`}>
              {count}/{MAX}
            </span>
          </div>
          {loading && (
            <div className="create-task-loading">טוען אנשים לתיוג…</div>
          )}
          {fetchError && (
            <div className="reply-error">שגיאה בטעינת אנשים: {fetchError}</div>
          )}
          {!loading && !fetchError && assignees && assignees.length === 0 && (
            <div className="create-task-loading">
              לא מוגדרים אנשים עבור פרויקט זה ב-Keys.
            </div>
          )}
        </label>

        <label className="create-task-label">
          תאריך יעד <span className="create-task-hint">(אופציונלי)</span>
          <input
            type="date"
            className="create-task-due"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            disabled={isPending}
          />
        </label>

        <div className="reply-drawer-foot create-task-foot">
          {submitError && <span className="reply-error">{submitError}</span>}
          <span className="reply-drawer-spacer" />
          <button
            type="button"
            className="reply-btn reply-btn-ghost"
            onClick={closeDrawer}
            disabled={isPending}
          >
            ביטול
          </button>
          <button
            type="button"
            className="reply-btn reply-btn-primary"
            onClick={submit}
            disabled={isPending || count === 0 || over}
          >
            {isPending
              ? "יוצר…"
              : finalMentions.length > 0
                ? `צור · תייג ${finalMentions.length}`
                : "צור"}
          </button>
        </div>

        {pickerOpen && (
          <div
            className="mention-dropdown open"
            style={{ top: picker.top, left: picker.left }}
            role="listbox"
          >
            {results.map((r, i) => (
              <div
                key={r.email}
                className={`mention-item ${i === picker.index ? "is-active" : ""}`}
                role="option"
                aria-selected={i === picker.index}
                onMouseDown={(e) => {
                  // mousedown, not click — avoids blurring the textarea
                  // before we can apply the selection.
                  e.preventDefault();
                  applySelection(r);
                }}
                onMouseEnter={() =>
                  setPicker((p) => ({ ...p, index: i }))
                }
              >
                <Avatar name={r.email} title={r.name} size={22} />
                <span className="mention-item-name">{r.name}</span>
                <RoleChip role={r.role} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
