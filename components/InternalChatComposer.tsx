"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Assignee } from "@/lib/appsScript";
import Avatar from "./Avatar";
import RoleChip from "./RoleChip";

const MAX = 4000;

type PickerState = {
  /** Position of the `@` in the textarea value. -1 = picker closed. */
  queryStart: number;
  /** Text typed after `@` so far. */
  query: string;
  /** Keyboard-highlighted result index. */
  index: number;
  /** Viewport coords (position:fixed dropdown). */
  top: number;
  left: number;
};

const CLOSED: PickerState = { queryStart: -1, query: "", index: 0, top: 0, left: 0 };

/**
 * Inline composer at the bottom of the internal Chat tab. Posts a
 * message into the project's Chat space via /api/chat/post.
 *
 * @-mention picker: typing `@` opens a dropdown of project members.
 * Selecting one inserts `@<name> ` into the body. Plain text — Chat
 * doesn't always auto-link these as real mentions when sent via API
 * (it does for messages typed natively in Chat). For phase 1 we
 * accept that limitation; the recipient still SEES their name in
 * the message and can read it. Programmatic mention annotations
 * (which would notify the user properly) are a follow-up — they
 * need an email→gaia-id resolution per recipient on submit.
 *
 * UX shape mirrors CreateTaskDrawer's picker:
 *   - Arrow up/down navigates results
 *   - Enter / Tab inserts the highlighted result
 *   - Esc closes the picker (a second Esc clears the textarea)
 *   - ⌘/Ctrl+Enter submits
 */
export default function InternalChatComposer({
  project,
}: {
  project: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [picker, setPicker] = useState<PickerState>(CLOSED);
  const [assignees, setAssignees] = useState<Assignee[] | null>(null);
  const [loadingAssignees, setLoadingAssignees] = useState(false);
  // Track every @-mention the user has picked from the dropdown.
  // Map keyed by email so re-picking the same person doesn't double
  // up. Names are kept alongside so the server can scan the final
  // text for `@<name>` and convert each occurrence into a real
  // USER_MENTION annotation when posting.
  const [pickedMentions, setPickedMentions] = useState<
    Map<string, string>
  >(new Map());
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Lazy-fetch project members on first picker-open. Same endpoint
  // CreateTaskDrawer uses — single source of truth for "who is on
  // this project's roster". Cached per-component-instance only;
  // re-mount = re-fetch, which is fine since we're behind the
  // suspense'd internal-tab boundary.
  useEffect(() => {
    if (assignees !== null || loadingAssignees) return;
    if (picker.queryStart < 0) return; // wait until the user actually opens the picker
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
        // silent — picker just shows empty / falls back to typed text
      } finally {
        setLoadingAssignees(false);
      }
    })();
  }, [picker.queryStart, project, assignees, loadingAssignees]);

  const results = useMemo(() => {
    if (picker.queryStart < 0 || !assignees) return [] as Assignee[];
    const q = picker.query.toLowerCase();
    return assignees
      .filter(
        (a) =>
          !q ||
          a.name.toLowerCase().includes(q) ||
          a.email.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [picker.queryStart, picker.query, assignees]);

  function openPickerAt(textarea: HTMLTextAreaElement, queryStart: number, query: string) {
    const rect = textarea.getBoundingClientRect();
    setPicker({
      queryStart,
      query,
      index: 0,
      top: rect.top - 8,
      left: rect.left,
    });
  }

  function closePicker() {
    setPicker(CLOSED);
  }

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
    if (hasAt) openPickerAt(textarea, i, value.slice(i + 1, pos));
    else closePicker();
  }

  function applySelection(r: Assignee) {
    const ta = textareaRef.current;
    if (!ta) return;
    const cursor = ta.selectionEnd;
    const before = value.slice(0, picker.queryStart);
    const after = value.slice(cursor);
    const insert = "@" + r.name + " ";
    const newValue = before + insert + after;
    setValue(newValue);
    setPickedMentions((prev) => {
      const next = new Map(prev);
      next.set(r.email, r.name);
      return next;
    });
    closePicker();
    requestAnimationFrame(() => {
      const newPos = (before + insert).length;
      ta.setSelectionRange(newPos, newPos);
      ta.focus();
    });
  }

  function onChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value;
    setValue(v);
    updatePickerFromCursor(v, e.target);
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
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setValue("");
      setError(null);
    }
  }

  // Close the picker if the user clicks outside it / the textarea.
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

  function submit() {
    const text = value.trim();
    if (!text) {
      setError("הודעה לא יכולה להיות ריקה.");
      return;
    }
    if (text.length > MAX) {
      setError(`ארוך מדי (${text.length}/${MAX}).`);
      return;
    }
    setError(null);
    // Re-verify each tracked mention is still in the body — user
    // may have backspaced the @<name> token after picking. Server
    // also tolerates dead mentions (silently skips), but trimming
    // here is cheap.
    const mentions = Array.from(pickedMentions.entries())
      .filter(([, name]) => text.includes("@" + name))
      .map(([email, name]) => ({ email, name }));

    // Optimistic clear — same rationale as ReplyDrawer. If the post
    // fails we restore the typed text + show the error inline.
    setValue("");
    setPickedMentions(new Map());
    closePicker();
    startTransition(async () => {
      try {
        const res = await fetch("/api/chat/post", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ project, text, mentions }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
        };
        if (!res.ok || !data.ok) {
          throw new Error(data.error || `Request failed (${res.status})`);
        }
        router.refresh();
      } catch (e) {
        setValue(text);
        // Restore the mention map so the user doesn't have to re-pick.
        setPickedMentions((prev) => {
          if (prev.size > 0) return prev;
          const restored = new Map<string, string>();
          for (const m of mentions) restored.set(m.email, m.name);
          return restored;
        });
        setError(e instanceof Error ? e.message : String(e));
        requestAnimationFrame(() => textareaRef.current?.focus());
      }
    });
  }

  // Count of live (still-in-body) mentions for the footer hint.
  const liveMentions = useMemo(() => {
    let n = 0;
    pickedMentions.forEach((name) => {
      if (value.includes("@" + name)) n++;
    });
    return n;
  }, [value, pickedMentions]);
  const count = value.trim().length;
  const over = count > MAX;
  const pickerOpen = picker.queryStart >= 0 && results.length > 0;

  return (
    <div className="chat-composer">
      <textarea
        ref={textareaRef}
        className="reply-textarea"
        rows={3}
        value={value}
        placeholder="כתוב הודעה לחלל הצ׳אט הפנימי… (@ לתיוג, ⌘/Ctrl+Enter לשליחה)"
        onChange={onChange}
        onKeyUp={(e) => updatePickerFromCursor(value, e.currentTarget)}
        onClick={(e) => updatePickerFromCursor(value, e.currentTarget)}
        onKeyDown={onKeyDown}
        disabled={isPending}
        maxLength={MAX + 1}
      />
      <div className="chat-composer-foot">
        {liveMentions > 0 && (
          <span className="create-task-mentions-hint">
            תויגו: {liveMentions}
          </span>
        )}
        <span className={`reply-count ${over ? "is-over" : ""}`}>
          {count}/{MAX}
        </span>
        {error && <span className="reply-error">{error}</span>}
        <span className="reply-drawer-spacer" />
        <button
          type="button"
          className="reply-btn reply-btn-primary"
          onClick={submit}
          disabled={isPending || count === 0 || over}
          title="ההודעה תופיע בחלל הצ׳אט הפנימי בשמך"
        >
          {isPending ? "שולח…" : "שלח לצ׳אט"}
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
  );
}
