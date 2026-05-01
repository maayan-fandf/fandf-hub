"use client";

import { useCallback, useState } from "react";
import Avatar from "./Avatar";
import CommentBody from "./CommentBody";
import type { CommentItem } from "@/lib/appsScript";
import { formatDateIso } from "@/lib/dateFormat";

type Props = {
  /** The parent (thread-root) comment's id. Replies to THIS id are loaded. */
  parentCommentId: string;
  /** Project name — required by the API for access scoping. */
  project: string;
  /** Reply count hint from the parent's payload — shown in the chip label.
   *  If 0 or missing, the chip doesn't render at all. */
  count: number;
};

/**
 * Inline thread-expansion chip. Renders a "💬 N" button; on click, fetches
 * the replies once and toggles a nested list below the card. Collapsing
 * keeps the fetched replies in state so reopening is instant.
 *
 * Read-only — no writes go through here. The reply-posting flow still lives
 * in ReplyDrawer which reaches the existing /api/comments/reply + Chat +
 * Tasks integration path.
 */
export default function ThreadReplies({
  parentCommentId,
  project,
  count,
}: Props) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replies, setReplies] = useState<CommentItem[]>([]);

  const fetchReplies = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = `/api/comments/replies?parentId=${encodeURIComponent(parentCommentId)}&project=${encodeURIComponent(project)}`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      const data = (await res.json()) as { replies: CommentItem[] };
      setReplies(data.replies ?? []);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [parentCommentId, project]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !loaded && !loading) fetchReplies();
  }

  if (!count || count <= 0) return null;

  return (
    <>
      <button
        type="button"
        className={`chip chip-muted thread-toggle${open ? " is-open" : ""}`}
        onClick={toggle}
        title={open ? "הסתר תגובות" : "הצג תגובות בשיחה"}
        aria-expanded={open}
      >
        💬 {count}
        <span className="thread-toggle-chev" aria-hidden>
          {open ? "▾" : "◂"}
        </span>
      </button>
      {open && (
        <div className="thread-replies" role="region" aria-label="תגובות בשרשור">
          {loading && (
            <div className="thread-replies-loading">טוען תגובות…</div>
          )}
          {error && (
            <div className="thread-replies-error">שגיאה: {error}</div>
          )}
          {loaded && replies.length === 0 && !error && (
            <div className="thread-replies-empty">אין תגובות עדיין.</div>
          )}
          {loaded && replies.length > 0 && (
            <ul className="thread-replies-list">
              {replies.map((r) => (
                <li key={r.comment_id} className="thread-reply">
                  <Avatar
                    name={r.author_email}
                    title={r.author_name || r.author_email}
                    size={22}
                  />
                  <div className="thread-reply-body">
                    <div className="thread-reply-head">
                      <span className="thread-reply-author">
                        {r.author_name || r.author_email}
                      </span>
                      <span className="thread-reply-time" title={r.timestamp}>
                        {formatRelative(r.timestamp)}
                      </span>
                      {r.edited_at && (
                        <span
                          className="chip chip-muted"
                          title={`נערך ${formatRelative(r.edited_at)}`}
                        >
                          📝 נערך
                        </span>
                      )}
                    </div>
                    <CommentBody
                      body={r.body}
                      className="thread-reply-text"
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
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
