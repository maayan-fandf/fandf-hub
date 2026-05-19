"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Assignee } from "@/lib/appsScript";
import Avatar from "@/components/Avatar";
import RoleChip from "@/components/RoleChip";

const MAX = 4000;

// `@email@host.tld` — the SAME token shape CommentBody renders as an
// avatar + Hebrew-name chip and commentsWriteDirect parses. Keeping the
// inserted token an email (not a display name) is what makes a tagged
// person show up with their avatar after the message is sent.
const MENTION_RE = /@([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;

function parseMentionEmails(body: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(body)) !== null) out.add(m[1].toLowerCase());
  return Array.from(out);
}

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

const CLOSED: PickerState = {
  queryStart: -1,
  query: "",
  index: 0,
  top: 0,
  left: 0,
};

/**
 * Inline composer at the bottom of a hub discussion channel — drives
 * BOTH the internal (F&F-only) and shared (client-visible) tabs.
 *
 * @-mention picker: typing `@` opens a dropdown of project members
 * (same `/api/projects/assignees` source the task form uses). The
 * dropdown shows the Hebrew name + avatar; picking one inserts the
 * person's `@<email>` token into the body. That token is what
 * CommentBody turns into an avatar + Hebrew-name chip once the message
 * is posted (the hub-wide mention convention), and the emails parsed
 * out of the body on submit are sent as `assignees` to
 * `/api/tasks/create` → createMentionDirect, which fans out a real
 * `mention` notification per person and stamps the comment with the
 * channel `scope`. Manually-typed `@email` works too.
 *
 * Audience:
 *   - scope="internal" → F&F-only channel; the client never sees it
 *     (only rendered for internal users). Mentions stay internal.
 *   - scope="shared" → client-visible channel. `isClientUser` flips
 *     the wording (client → "לצוות", staff → "ללקוח").
 *
 * Send is decoupled from the page refresh: the "שולח…" state ends as
 * soon as the POST resolves; `router.refresh()` then updates the
 * discussion list in the background. (Previously the spinner was tied
 * to a full project-page re-render inside the transition — sending
 * felt like it took "forever".)
 */
export default function ClientChatComposer({
  project,
  isClientUser,
  scope = "shared",
}: {
  project: string;
  isClientUser: boolean;
  scope?: "internal" | "shared";
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [picker, setPicker] = useState<PickerState>(CLOSED);
  const [assignees, setAssignees] = useState<Assignee[] | null>(null);
  const [loadingAssignees, setLoadingAssignees] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const isInternal = scope === "internal";
  const audience = isInternal ? "פנימית" : isClientUser ? "לצוות" : "ללקוח";
  const placeholder = isInternal
    ? "כתוב הודעה פנימית (צוות F&F בלבד)... @ לתיוג, ⌘/Ctrl+Enter לשליחה"
    : isClientUser
      ? "כתוב הודעה לצוות... @ לתיוג, ⌘/Ctrl+Enter לשליחה"
      : "כתוב הודעה ללקוח... @ לתיוג, ⌘/Ctrl+Enter לשליחה";

  // Lazy-fetch the project roster the first time the picker opens.
  // Same endpoint + he_name enrichment the task form's picker uses.
  useEffect(() => {
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
        // silent — picker just stays empty; typed text still posts
      } finally {
        setLoadingAssignees(false);
      }
    })();
  }, [picker.queryStart, project, assignees, loadingAssignees]);

  // Close the picker on outside click.
  useEffect(() => {
    if (picker.queryStart < 0) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".mention-dropdown")) return;
      if (target === textareaRef.current) return;
      setPicker(CLOSED);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [picker.queryStart]);

  // Dropdown label preference: he_name (Hebrew) > name > email-prefix.
  // This is only what the user SEES while picking — the token inserted
  // into the body is always the email (see applySelection).
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
    setPicker({ queryStart, query, index: 0, top: rect.top - 8, left: rect.left });
  }

  function updatePickerFromCursor(
    value: string,
    textarea: HTMLTextAreaElement,
  ) {
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
    // Don't re-open the picker mid-completed-email (`@a@b.com`): if the
    // span after `@` already contains another `@`, it's a finished
    // mention token, not an in-progress query.
    const span = hasAt ? value.slice(i + 1, pos) : "";
    if (hasAt && !span.includes("@")) openPickerAt(textarea, i, span);
    else setPicker(CLOSED);
  }

  function applySelection(r: Assignee) {
    const ta = textareaRef.current;
    if (!ta) return;
    const cursor = ta.selectionEnd;
    const before = body.slice(0, picker.queryStart);
    const after = body.slice(cursor);
    // Insert the EMAIL token — CommentBody renders `@email@host` as the
    // person's avatar + Hebrew display name once posted (and the submit
    // parse below turns it into a real `assignees` notification). The
    // dropdown already showed the friendly name for picking.
    const insert = "@" + r.email + " ";
    const newValue = before + insert + after;
    setBody(newValue);
    setPicker(CLOSED);
    requestAnimationFrame(() => {
      const newPos = (before + insert).length;
      ta.setSelectionRange(newPos, newPos);
      ta.focus();
    });
  }

  function onChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value;
    setBody(v);
    updatePickerFromCursor(v, e.target);
  }

  async function submit() {
    const text = body.trim();
    if (!text) {
      setError("הודעה לא יכולה להיות ריקה.");
      return;
    }
    if (text.length > MAX) {
      setError(`ארוך מדי (${text.length}/${MAX}).`);
      return;
    }
    setError(null);
    const sendingText = text;
    // The body IS the source of truth for who's tagged — parse every
    // `@email` token (picked OR hand-typed). createMentionDirect
    // notifies each + applies scope (internal mentions stay F&F-only).
    const sendAssignees = parseMentionEmails(sendingText);
    setBody("");
    setSending(true);
    try {
      const res = await fetch("/api/tasks/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project,
          body: sendingText,
          assignees: sendAssignees,
          due: "",
          scope,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      // Send is done — free the composer NOW. The discussion list is a
      // server component; refresh it in the BACKGROUND (don't gate the
      // spinner on a full project-page re-render — that was the
      // "forever to send" lag).
      setSending(false);
      router.refresh();
    } catch (e) {
      // Restore the body so the user doesn't lose what they typed,
      // surface the error inline, refocus.
      setBody(sendingText);
      setSending(false);
      setError(e instanceof Error ? e.message : String(e));
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
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
        setPicker(CLOSED);
        return;
      }
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setBody("");
      setError(null);
    }
  }

  const count = body.trim().length;
  const over = count > MAX;
  const empty = count === 0;
  const pickerOpen = picker.queryStart >= 0 && results.length > 0;

  return (
    <div className="client-chat-composer">
      <textarea
        ref={textareaRef}
        className="reply-textarea client-chat-composer-input"
        rows={2}
        value={body}
        placeholder={placeholder}
        onChange={onChange}
        onKeyDown={onKeyDown}
        disabled={sending}
        maxLength={MAX + 1}
        aria-label={`הודעה חדשה ${audience}`}
      />
      <div className="client-chat-composer-foot">
        {error && (
          <span className="reply-error" role="alert">
            {error}
          </span>
        )}
        <span className={`reply-count ${over ? "is-over" : ""}`}>
          {count}/{MAX}
        </span>
        <button
          type="button"
          className="reply-btn reply-btn-primary"
          onClick={() => void submit()}
          disabled={sending || empty || over}
          title={
            isInternal
              ? "פרסם הודעה פנימית — צוות F&F בלבד, הלקוח לא רואה"
              : isClientUser
                ? "פרסם הודעה לצוות בפרוייקט"
                : "פרסם הודעה לערוץ הלקוח"
          }
        >
          {sending ? "שולח…" : `שלח הודעה ${audience}`}
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
