"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Assignee } from "@/lib/appsScript";
import Avatar from "@/components/Avatar";
import RoleChip from "@/components/RoleChip";

type Props = {
  commentId: string;
  /** The current body text of the comment being edited. */
  initialBody: string;
  /**
   * If true, show the edit button as disabled (thread is resolved and the
   * server will reject). We hide the button in that case rather than
   * render a disabled control — cleaner UX.
   */
  locked?: boolean;
  /** Small label on the button. Default "ערוך". */
  label?: string;
  /** Render the trigger as an icon-only button (✏️) with the label as a
   *  tooltip. Used by CardActions. */
  iconOnly?: boolean;
  /** Project the comment lives on. When set, the edit textarea gets the
   *  same @-mention picker as ClientChatComposer (typing `@` opens a
   *  dropdown of project members, picking inserts the `@email` token).
   *  Without it the textarea stays plain — older callers (inbox row
   *  before threading project state) keep working. Reported by
   *  Maayan 2026-06-05: posting an alert to the internal chat worked,
   *  but reopening the same comment to add an `@name` mention had no
   *  picker. The composer's picker now lives here too. */
  project?: string;
};

const MAX = 4000;

// Same mention shape ClientChatComposer / CommentBody parse — the body
// token is always `@<email>` (CommentBody renders it as avatar + Hebrew
// name once persisted). The dropdown shows the friendly Hebrew name; the
// inserted text is the email so server-side mention parsing works.

type PickerState = {
  /** Index in the body of the `@` that opened the picker. -1 = closed. */
  queryStart: number;
  /** Text typed after `@` so far (the live filter query). */
  query: string;
  /** Keyboard-highlighted result index. */
  index: number;
  /** Viewport coords for the position:fixed dropdown. */
  top: number;
  left: number;
};

const PICKER_CLOSED: PickerState = {
  queryStart: -1,
  query: "",
  index: 0,
  top: 0,
  left: 0,
};

/**
 * Inline edit drawer for comment bodies. Mirrors ReplyDrawer's flow:
 * click → textarea pre-filled with the current body → save/cancel.
 * Submits to /api/comments/edit which patches the sheet + syncs the
 * linked Google Tasks' title/notes.
 *
 * Hidden entirely when `locked` is true — the server would reject the
 * edit on resolved threads anyway.
 *
 * When `project` is provided, the textarea hosts the same `@`-mention
 * picker as the new-message composer (ClientChatComposer): lazy-loads
 * the project roster, arrow/Enter to pick, inserts `@<email>` tokens
 * that CommentBody renders as avatar chips on save.
 */
export default function EditDrawer({
  commentId,
  initialBody,
  locked = false,
  label = "ערוך",
  iconOnly = false,
  project,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(initialBody);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Mention picker — only meaningful when we know which project to
  // pull the roster from. Roster fetch is lazy: first `@` opens it.
  const [picker, setPicker] = useState<PickerState>(PICKER_CLOSED);
  const [assignees, setAssignees] = useState<Assignee[] | null>(null);
  const [loadingAssignees, setLoadingAssignees] = useState(false);

  useEffect(() => {
    if (!project) return;
    if (assignees !== null || loadingAssignees) return;
    if (picker.queryStart < 0) return;
    setLoadingAssignees(true);
    (async () => {
      try {
        const res = await fetch(
          `/api/projects/assignees?project=${encodeURIComponent(project)}`,
        );
        if (res.ok) {
          const data = (await res.json()) as { assignees: Assignee[] };
          setAssignees(data.assignees);
        }
      } catch {
        // silent — picker stays empty; manually-typed `@email` still posts.
      } finally {
        setLoadingAssignees(false);
      }
    })();
  }, [picker.queryStart, project, assignees, loadingAssignees]);

  // Outside-click closes the picker (not the drawer — drawer has its
  // own Cancel button).
  useEffect(() => {
    if (picker.queryStart < 0) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".mention-dropdown")) return;
      if (target === textareaRef.current) return;
      setPicker(PICKER_CLOSED);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [picker.queryStart]);

  const labelOf = (a: Assignee): string => {
    const he = (a.he_name || "").trim();
    if (he) return he;
    return (a.name || a.email.split("@")[0] || "").trim();
  };

  const results = useMemo(() => {
    if (picker.queryStart < 0 || !assignees) return [] as Assignee[];
    const q = picker.query.toLowerCase();
    return assignees
      .filter(
        (a) =>
          !q ||
          a.name.toLowerCase().includes(q) ||
          (a.he_name || "").toLowerCase().includes(q) ||
          a.email.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [picker.queryStart, picker.query, assignees]);

  function openPickerAt(
    textarea: HTMLTextAreaElement,
    queryStart: number,
    query: string,
  ) {
    const rect = textarea.getBoundingClientRect();
    setPicker({
      queryStart,
      query,
      index: 0,
      top: rect.top - 8,
      left: rect.left,
    });
  }

  function updatePickerFromCursor(
    nextValue: string,
    textarea: HTMLTextAreaElement,
  ) {
    if (!project) return; // no roster source → never open
    const pos = textarea.selectionStart;
    let i = pos - 1;
    let hasAt = false;
    while (i >= 0) {
      const ch = nextValue[i];
      if (ch === "@") {
        hasAt = true;
        break;
      }
      if (/\s/.test(ch)) break;
      i--;
    }
    const span = hasAt ? nextValue.slice(i + 1, pos) : "";
    // Don't re-open mid-completed-email (`@a@b.com`) — that's already
    // a finished mention token, not an in-progress query.
    if (hasAt && !span.includes("@")) openPickerAt(textarea, i, span);
    else setPicker(PICKER_CLOSED);
  }

  function applySelection(r: Assignee) {
    const ta = textareaRef.current;
    if (!ta) return;
    const cursor = ta.selectionEnd;
    const before = value.slice(0, picker.queryStart);
    const after = value.slice(cursor);
    const insert = "@" + r.email + " ";
    const newValue = before + insert + after;
    setValue(newValue);
    setPicker(PICKER_CLOSED);
    requestAnimationFrame(() => {
      const newPos = (before + insert).length;
      ta.setSelectionRange(newPos, newPos);
      ta.focus();
    });
  }

  if (locked) return null;

  function openDrawer() {
    setOpen(true);
    setValue(initialBody);
    setError(null);
    setPicker(PICKER_CLOSED);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      // Put the caret at the end rather than selecting everything — users
      // editing typos want to tap into the existing text.
      const len = el.value.length;
      try {
        el.setSelectionRange(len, len);
      } catch {
        /* noop for unsupported types */
      }
    });
  }

  function closeDrawer() {
    setOpen(false);
    setValue(initialBody);
    setError(null);
    setPicker(PICKER_CLOSED);
  }

  function submit() {
    const body = value.trim();
    if (!body) {
      setError("גוף ההערה לא יכול להיות ריק.");
      return;
    }
    if (body.length > MAX) {
      setError(`ארוך מדי (${body.length}/${MAX}).`);
      return;
    }
    if (body === initialBody.trim()) {
      // No change → just close.
      closeDrawer();
      return;
    }
    setError(null);

    // Optimistic close — see ReplyDrawer.submit for the rationale. The
    // edited body is already on the user's screen (they typed it); the
    // server reconciliation arrives via router.refresh() right after.
    // On error we reopen with the edited body restored.
    closeDrawer();
    startTransition(async () => {
      try {
        const res = await fetch("/api/comments/edit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ commentId, body }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || `Request failed (${res.status})`);
        }
        router.refresh();
      } catch (err) {
        setValue(body);
        setError(err instanceof Error ? err.message : String(err));
        setOpen(true);
      }
    });
  }

  function onChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value;
    setValue(v);
    updatePickerFromCursor(v, e.target);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Picker-aware keys take priority while the dropdown is open.
    if (picker.queryStart >= 0 && results.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setPicker((p) => ({
          ...p,
          index: Math.min(p.index + 1, results.length - 1),
        }));
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
        setPicker(PICKER_CLOSED);
        return;
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeDrawer();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className={iconOnly ? "card-action" : "reply-btn"}
        onClick={openDrawer}
        title={iconOnly ? label : "ערוך את גוף ההערה (⌘/Ctrl+Enter לשמירה)"}
        aria-label={iconOnly ? label : undefined}
      >
        {iconOnly ? "✏️" : label}
      </button>
    );
  }

  const count = value.trim().length;
  const over = count > MAX;
  const unchanged = value.trim() === initialBody.trim();
  const pickerOpen = picker.queryStart >= 0 && results.length > 0;

  return (
    <div className="reply-drawer">
      {/* Edit drawer textarea — taller than ReplyDrawer's (which is
          rows=3 for compact quick replies) because edits commonly
          touch existing multi-line bodies. The textarea is still
          resize: vertical (per .reply-textarea CSS) so the user can
          shrink or grow it from here. Reported by Maayan 2026-05-06:
          the prior 3-row default felt cramped when editing anything
          longer than a one-liner. */}
      <textarea
        ref={textareaRef}
        className="reply-textarea"
        rows={8}
        value={value}
        placeholder="ערוך… (⌘/Ctrl+Enter לשמירה, Esc לביטול)"
        onChange={onChange}
        onKeyDown={onKeyDown}
        disabled={isPending}
        maxLength={MAX + 1}
      />
      <div className="reply-drawer-foot">
        <span className={`reply-count ${over ? "is-over" : ""}`}>
          {count}/{MAX}
        </span>
        {error && <span className="reply-error">{error}</span>}
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
          disabled={isPending || count === 0 || over || unchanged}
        >
          {isPending ? "שומר…" : "שמור"}
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
                e.preventDefault();
                applySelection(r);
              }}
              onMouseEnter={() => setPicker((p) => ({ ...p, index: i }))}
            >
              <Avatar name={r.email} title={r.he_name || r.name} size={22} />
              <span className="mention-item-name">{labelOf(r)}</span>
              <RoleChip role={r.role} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
