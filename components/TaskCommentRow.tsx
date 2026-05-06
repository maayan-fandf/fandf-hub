"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Avatar, { avatarHoverText } from "./Avatar";
import CommentBody from "./CommentBody";
import DeleteButton from "./DeleteButton";
import { formatDateIso } from "@/lib/dateFormat";
import { personDisplayName } from "@/lib/personDisplay";
import type { TasksPerson } from "@/lib/appsScript";

type Comment = {
  comment_id: string;
  body: string;
  author_email: string;
  author_name?: string;
  timestamp: string;
  edited_at?: string | null;
};

const MAX = 4000;

/**
 * One row of the task discussion. Owns the local "is this comment
 * being edited?" state so the textarea can render IN PLACE of the
 * rendered body — same width, same position — instead of opening a
 * separate drawer below the comment. Reported by Maayan 2026-05-06:
 * the EditDrawer's separate floating box added visual chrome that
 * felt foreign next to the rendered conversation.
 *
 * The edit affordance is the same ✏️ in the head row. Click it →
 * the body region swaps from CommentBody to a textarea pre-filled
 * with the raw markdown-ish source. Save persists via the existing
 * /api/comments/edit endpoint, then router.refresh() pulls the new
 * rendered version back. Cancel discards.
 *
 * Other CommentBody surfaces (project discussion, /inbox, timeline)
 * still use the EditDrawer pattern for now — migrating them to this
 * inline-edit flow is a follow-up. The chat-feeling task thread is
 * where the visual mismatch hurt most.
 */
export default function TaskCommentRow({
  comment,
  people,
  canEdit,
  canDelete,
}: {
  comment: Comment;
  people: TasksPerson[];
  canEdit: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(comment.body || "");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Pre-fill + focus when entering edit mode. Caret at the end so
  // typo-fixers can tap right into the existing text.
  useEffect(() => {
    if (!editing) return;
    setValue(comment.body || "");
    setError(null);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const len = el.value.length;
      try {
        el.setSelectionRange(len, len);
      } catch {
        /* noop */
      }
      // Auto-grow to fit the existing content so the textarea visually
      // matches the rendered body's vertical footprint instead of
      // starting at a fixed row count.
      autoSize(el);
    });
  }, [editing, comment.body]);

  function autoSize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }

  function cancel() {
    setEditing(false);
    setValue(comment.body || "");
    setError(null);
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
    if (body === (comment.body || "").trim()) {
      // No change → just close.
      cancel();
      return;
    }
    setError(null);
    // Optimistic close + background save. On error we re-open with
    // the edited body restored so the user doesn't lose their typing.
    setEditing(false);
    startTransition(async () => {
      try {
        const res = await fetch("/api/comments/edit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ commentId: comment.comment_id, body }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(data.error || `Request failed (${res.status})`);
        }
        router.refresh();
      } catch (err) {
        setValue(body);
        setError(err instanceof Error ? err.message : String(err));
        setEditing(true);
      }
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  }

  const authorDisplay =
    personDisplayName(comment.author_email, people) ||
    comment.author_name ||
    comment.author_email;
  const authorRole = people?.find(
    (p) => p.email.toLowerCase() === comment.author_email.toLowerCase(),
  )?.role;
  const authorHover = avatarHoverText(
    authorDisplay,
    comment.author_email,
    authorRole,
  );

  return (
    <li className="thread-reply">
      <Avatar
        name={comment.author_email}
        title={authorDisplay}
        role={authorRole}
        size={26}
      />
      <div className="thread-reply-body">
        <div className="thread-reply-head">
          <span className="thread-reply-author" title={authorHover}>
            {authorDisplay}
          </span>
          <span className="thread-reply-time" title={comment.timestamp}>
            {formatRelative(comment.timestamp)}
          </span>
          {comment.edited_at && (
            <span
              className="chip chip-muted"
              title={`נערך ${formatRelative(comment.edited_at)}`}
            >
              📝 נערך
            </span>
          )}
          {(canEdit || canDelete) && !editing && (
            <span className="thread-reply-actions">
              {canEdit && (
                <button
                  type="button"
                  className="card-action"
                  onClick={() => setEditing(true)}
                  title="ערוך את גוף ההערה (⌘/Ctrl+Enter לשמירה)"
                  aria-label="ערוך"
                >
                  ✏️
                </button>
              )}
              {canDelete && (
                <DeleteButton
                  commentId={comment.comment_id}
                  itemLabel="את ההערה"
                  iconOnly
                />
              )}
            </span>
          )}
        </div>
        {editing ? (
          // In-place edit — textarea takes the body's slot rather
          // than rendering as a separate floating drawer below. The
          // `thread-reply-text` class is preserved on the wrapper so
          // the field inherits the same width / spacing the rendered
          // body would have occupied. Save / Cancel sit immediately
          // below the textarea — same column, no chrome.
          <div className="thread-reply-text thread-reply-edit">
            <textarea
              ref={textareaRef}
              className="thread-reply-edit-textarea"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                autoSize(e.currentTarget);
              }}
              onKeyDown={onKeyDown}
              maxLength={MAX + 1}
              disabled={isPending}
              placeholder="ערוך… (⌘/Ctrl+Enter לשמירה, Esc לביטול)"
              dir="auto"
            />
            <div className="thread-reply-edit-foot">
              <span
                className={`thread-reply-edit-count${
                  value.trim().length > MAX ? " is-over" : ""
                }`}
              >
                {value.trim().length}/{MAX}
              </span>
              {error && (
                <span className="thread-reply-edit-error">{error}</span>
              )}
              <span className="thread-reply-edit-spacer" />
              <button
                type="button"
                className="reply-btn reply-btn-ghost"
                onClick={cancel}
                disabled={isPending}
              >
                ביטול
              </button>
              <button
                type="button"
                className="reply-btn reply-btn-primary"
                onClick={submit}
                disabled={
                  isPending ||
                  value.trim().length === 0 ||
                  value.trim().length > MAX ||
                  value.trim() === (comment.body || "").trim()
                }
              >
                {isPending ? "שומר…" : "שמור"}
              </button>
            </div>
          </div>
        ) : (
          <CommentBody
            body={comment.body}
            className="thread-reply-text"
            people={people}
          />
        )}
      </div>
    </li>
  );
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const now = Date.now();
  const diffSec = Math.round((now - then) / 1000);
  if (diffSec < 60) return "עכשיו";
  const mins = Math.round(diffSec / 60);
  if (mins < 60) return `לפני ${mins} ד׳`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `לפני ${hrs} ש׳`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `לפני ${days} י׳`;
  return formatDateIso(iso);
}
