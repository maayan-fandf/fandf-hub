"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Props = {
  taskId: string;
  /** The task's project name. Used to fetch the project's roster
   *  for the @-mention autocomplete. When omitted (e.g. legacy
   *  caller), the picker is disabled and the user can still type
   *  raw `@<email>` — server-side parsing already handles that. */
  project?: string;
};

type Person = { email: string; name: string; role: string };

const MAX = 4000;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

type UploadResponse =
  | { ok: true; fileId: string; name: string; mimeType: string; viewUrl: string; embedUrl: string }
  | { ok: false; error: string };

type MentionState = {
  /** Index of the `@` character in the textarea value. */
  startIdx: number;
  /** Lowercased filter string typed after the `@`. */
  fragment: string;
  /** Selected index inside the filtered list. */
  selectedIdx: number;
};

/**
 * Permanent composer at the bottom of a task's comment thread. POSTs to
 * `/api/comments/reply` with `parentCommentId=taskId` — the Apps Script
 * `postReplyForUser_` handler treats a task row as a valid top-level parent
 * (it just needs `parent_id===''`, which tasks satisfy).
 *
 * Paste/drop an image → uploads the bytes to the task's Drive folder via
 * `/api/worktasks/upload`, then inserts an `![name](driveUrl)` token into
 * the textarea at the cursor. The comment renderer detects these tokens
 * and shows the image inline.
 *
 * Type `@` and the picker drops in below the textarea with the project
 * roster — arrow keys navigate, Enter/Tab inserts `@<email>`, Escape
 * dismisses. Server-side `@<email>` parsing already exists, so users
 * who prefer to type the full email manually still work.
 */
export default function TaskReplyComposer({ taskId, project }: Props) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [uploading, setUploading] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // @-mention picker state. `people` is loaded lazily on first @
  // keystroke and cached for the lifetime of the composer.
  const [people, setPeople] = useState<Person[] | null>(null);
  const [peopleLoading, setPeopleLoading] = useState(false);
  const [mention, setMention] = useState<MentionState | null>(null);

  // Lazy-load the project roster the first time the user types @.
  // Falls through silently on failure; the picker just stays empty
  // and the user can still type a raw email.
  useEffect(() => {
    if (!mention || !project || people !== null || peopleLoading) return;
    setPeopleLoading(true);
    void (async () => {
      try {
        const res = await fetch(
          `/api/projects/assignees?project=${encodeURIComponent(project)}`,
        );
        const data = (await res.json().catch(() => ({}))) as {
          assignees?: Person[];
          error?: string;
        };
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setPeople(Array.isArray(data.assignees) ? data.assignees : []);
      } catch {
        setPeople([]);
      } finally {
        setPeopleLoading(false);
      }
    })();
  }, [mention, project, people, peopleLoading]);

  // Filtered list for the picker — case-insensitive substring match
  // on email + name. Capped at 8 visible so the dropdown never
  // dominates the page.
  const filteredPeople = (() => {
    if (!mention || !people) return [];
    const f = mention.fragment.toLowerCase();
    const list = !f
      ? people
      : people.filter(
          (p) =>
            p.email.toLowerCase().includes(f) ||
            p.name.toLowerCase().includes(f),
        );
    return list.slice(0, 8);
  })();

  function insertAtCursor(text: string) {
    const el = textareaRef.current;
    if (!el) {
      setValue((v) => v + text);
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const next = el.value.slice(0, start) + text + el.value.slice(end);
    setValue(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + text.length;
      el.setSelectionRange(pos, pos);
    });
  }

  /** Look backwards from the cursor for an `@<chars>` fragment that
   *  isn't part of an existing email. Returns the start index of the
   *  `@` and the typed fragment, or null when there's no active
   *  mention to autocomplete. */
  function detectMention(
    text: string,
    cursorPos: number,
  ): { startIdx: number; fragment: string } | null {
    let i = cursorPos - 1;
    while (i >= 0) {
      const ch = text[i];
      if (ch === "@") {
        // The @ must be at the start of input or follow whitespace —
        // otherwise it's part of an email like "maayan@fandf.co.il".
        if (i > 0 && !/\s/.test(text[i - 1])) return null;
        return { startIdx: i, fragment: text.slice(i + 1, cursorPos) };
      }
      if (/\s/.test(ch)) return null;
      i--;
    }
    return null;
  }

  function onTextareaChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value;
    setValue(next);
    if (!project) {
      // Picker disabled — composer still works for raw `@<email>` typed by hand.
      return;
    }
    const cursor = e.target.selectionStart ?? next.length;
    const m = detectMention(next, cursor);
    if (m) {
      setMention((cur) =>
        cur && cur.startIdx === m.startIdx
          ? { ...cur, fragment: m.fragment }
          : { ...m, selectedIdx: 0 },
      );
    } else {
      setMention(null);
    }
  }

  function onSelectionChange() {
    if (!project) return;
    const el = textareaRef.current;
    if (!el) return;
    const cursor = el.selectionStart ?? 0;
    const m = detectMention(el.value, cursor);
    if (m) {
      setMention((cur) =>
        cur && cur.startIdx === m.startIdx
          ? { ...cur, fragment: m.fragment }
          : { ...m, selectedIdx: 0 },
      );
    } else {
      setMention(null);
    }
  }

  function pickMention(person: Person) {
    if (!mention) return;
    const el = textareaRef.current;
    if (!el) return;
    const cursor = el.selectionStart ?? value.length;
    // Replace the typed @<fragment> with `@<email> ` (trailing space
    // so the next character starts a fresh word, which keeps the
    // detector quiet).
    const before = value.slice(0, mention.startIdx);
    const after = value.slice(cursor);
    const insert = `@${person.email} `;
    const next = before + insert + after;
    setValue(next);
    setMention(null);
    requestAnimationFrame(() => {
      el.focus();
      const pos = before.length + insert.length;
      el.setSelectionRange(pos, pos);
    });
  }

  async function uploadFile(file: File): Promise<void> {
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(`הקובץ גדול מדי (${Math.round(file.size / 1024 / 1024)}MB, מקסימום 25MB).`);
      return;
    }
    const form = new FormData();
    form.set("taskId", taskId);
    form.set("file", file, file.name || "pasted-image.png");
    setUploading((n) => n + 1);
    setError(null);
    try {
      const res = await fetch("/api/worktasks/upload", {
        method: "POST",
        body: form,
      });
      const data = (await res.json().catch(() => ({}))) as UploadResponse;
      if (!res.ok || !("ok" in data) || !data.ok) {
        const msg = ("error" in data && data.error) || `העלאה נכשלה (${res.status})`;
        throw new Error(msg);
      }
      const safeName = (data.name || file.name || "file").replace(/[\[\]()]/g, "");
      // Image detection — try mime type first, fall back to extension.
      // Some upload paths (drag from another browser tab, certain
      // clipboard sources) leave file.type empty and the server stores
      // the file as application/octet-stream, which made our previous
      // mime-only check render real images as boring file links.
      const mimeType = (file.type || data.mimeType || "").toLowerCase();
      const fromMime = mimeType.startsWith("image/");
      const fromExt = /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)$/i.test(
        safeName,
      );
      const isImage = fromMime || fromExt;
      const token = isImage
        ? `\n![${safeName}](${data.viewUrl})\n`
        : `\n[📎 ${safeName}](${data.viewUrl})\n`;
      insertAtCursor(token);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading((n) => Math.max(0, n - 1));
    }
  }

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = e.clipboardData?.files;
    if (!files || files.length === 0) return;
    const imgs = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (imgs.length === 0) return;
    e.preventDefault();
    imgs.forEach((f) => {
      void uploadFile(f);
    });
  }

  function onDrop(e: React.DragEvent<HTMLTextAreaElement>) {
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    e.preventDefault();
    Array.from(files).forEach((f) => {
      void uploadFile(f);
    });
  }

  function onDragOver(e: React.DragEvent<HTMLTextAreaElement>) {
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
    }
  }

  function submit() {
    const body = value.trim();
    if (!body) {
      setError("תגובה לא יכולה להיות ריקה.");
      return;
    }
    if (body.length > MAX) {
      setError(`ארוך מדי (${body.length}/${MAX}).`);
      return;
    }
    if (uploading > 0) {
      setError("ממתינים להעלאה לסיום…");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/comments/reply", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ parentCommentId: taskId, body }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || `Request failed (${res.status})`);
        }
        setValue("");
        router.refresh();
        requestAnimationFrame(() => textareaRef.current?.focus());
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Picker keyboard nav takes precedence when the dropdown is open.
    if (mention && filteredPeople.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMention((cur) =>
          cur
            ? {
                ...cur,
                selectedIdx: Math.min(
                  cur.selectedIdx + 1,
                  filteredPeople.length - 1,
                ),
              }
            : cur,
        );
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMention((cur) =>
          cur ? { ...cur, selectedIdx: Math.max(cur.selectedIdx - 1, 0) } : cur,
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const pick = filteredPeople[mention.selectedIdx] || filteredPeople[0];
        if (pick) pickMention(pick);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  }

  const count = value.trim().length;
  const over = count > MAX;

  return (
    <div className="task-reply-composer">
      <div className="task-reply-composer-textarea-wrap">
        <textarea
          ref={textareaRef}
          className="reply-textarea"
          rows={3}
          value={value}
          placeholder="כתוב תגובה… (@ לתיוג · ⌘/Ctrl+Enter לשליחה · הדבק צילום מסך או גרור קובץ)"
          onChange={onTextareaChange}
          onKeyDown={onKeyDown}
          onKeyUp={onSelectionChange}
          onClick={onSelectionChange}
          onPaste={onPaste}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onBlur={() => {
            // Defer so a click on a picker row fires its onMouseDown
            // before the dropdown is dismissed.
            window.setTimeout(() => setMention(null), 150);
          }}
          disabled={isPending}
          maxLength={MAX + 1}
        />
        {mention && project && (
          <div className="mention-picker" role="listbox" aria-label="בחר אדם לתיוג">
            {peopleLoading && people === null && (
              <div className="mention-picker-status">טוען…</div>
            )}
            {!peopleLoading && filteredPeople.length === 0 && (
              <div className="mention-picker-status">אין תוצאות</div>
            )}
            {filteredPeople.map((p, i) => (
              <button
                key={p.email}
                type="button"
                role="option"
                aria-selected={i === mention.selectedIdx}
                className={`mention-picker-row${
                  i === mention.selectedIdx ? " is-active" : ""
                }`}
                // onMouseDown fires before the textarea's onBlur, so
                // the click lands while the picker is still open.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickMention(p);
                }}
              >
                <span className="mention-picker-name">{p.name}</span>
                <span className="mention-picker-email" dir="ltr">
                  {p.email}
                </span>
                {p.role && <span className="mention-picker-role">{p.role}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="reply-drawer-foot">
        <span className={`reply-count ${over ? "is-over" : ""}`}>
          {count}/{MAX}
        </span>
        {uploading > 0 && (
          <span className="reply-uploading">
            ⏳ מעלה {uploading > 1 ? `(${uploading})` : ""}…
          </span>
        )}
        {error && <span className="reply-error">{error}</span>}
        <span className="reply-drawer-spacer" />
        <button
          type="button"
          className="reply-btn reply-btn-primary"
          onClick={submit}
          disabled={isPending || count === 0 || over || uploading > 0}
        >
          {isPending ? "שולח…" : "שלח"}
        </button>
      </div>
    </div>
  );
}
