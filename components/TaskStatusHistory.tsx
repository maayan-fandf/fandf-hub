"use client";

import { useState } from "react";
import { STATUS_LABELS } from "@/components/TaskStatusCell";
import type { WorkTask, WorkTaskStatus } from "@/lib/appsScript";

type Props = {
  history: WorkTask["status_history"];
};

const DEFAULT_VISIBLE = 3;

/**
 * Vertical timeline view of a task's status changes. Replaces the
 * earlier flat list (one row per change separated by dashed borders).
 *
 * Each entry shows as a colored dot — drawn from the same
 * `tasks-status-{key}` palette the inline status pill / kanban
 * columns use, so the eye reads the dot's hue as "status" without
 * needing the label. A vertical line connects consecutive dots so
 * the chain reads as a single thread.
 *
 * Auto-collapses to the last DEFAULT_VISIBLE events with a "הצג עוד"
 * toggle — most tasks accumulate dozens of status changes over their
 * lifetime and the long tail is rarely useful day-to-day.
 *
 * Order: reverse-chronological (newest first). The audit-trail use
 * case is "what just happened?" — that lives at the top.
 */
export default function TaskStatusHistory({ history }: Props) {
  const [expanded, setExpanded] = useState(false);
  const items = history || [];

  if (items.length === 0) {
    return (
      <div className="task-status-history-empty">
        אין שינויי סטטוס להצגה.
      </div>
    );
  }

  // Reverse-chronological so the newest event sits at the top of the
  // timeline. Slicing AFTER reverse so "last 3" really means "last 3
  // chronologically" = "3 newest" = top 3 of the reversed list.
  const sorted = items.slice().reverse();
  const hidden = expanded ? 0 : Math.max(0, sorted.length - DEFAULT_VISIBLE);
  const visible = expanded ? sorted : sorted.slice(0, DEFAULT_VISIBLE);

  return (
    <div className="task-status-history">
      <ol className="task-status-history-list">
        {visible.map((h, i) => (
          <li
            key={`${h.at}-${i}`}
            className={`task-status-history-item tasks-status-${h.to}`}
          >
            <span
              className={`task-status-history-dot tasks-status-dot-${h.to}`}
              aria-hidden
            />
            <div className="task-status-history-content">
              <div className="task-status-history-head">
                <span className="task-status-history-status">
                  {labelFor(h.to as WorkTaskStatus)}
                </span>
                {h.from && (
                  <>
                    <span className="task-status-history-arrow" aria-hidden>
                      ←
                    </span>
                    <span className="task-status-history-from">
                      {labelFor(h.from as WorkTaskStatus)}
                    </span>
                  </>
                )}
              </div>
              <div className="task-status-history-meta">
                <time
                  dateTime={h.at}
                  className="task-status-history-time"
                  title={h.at}
                >
                  {formatTime(h.at)}
                </time>
                {h.by && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="task-status-history-by" title={h.by}>
                      {shortName(h.by)}
                    </span>
                  </>
                )}
                {h.note && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="task-status-history-note">{h.note}</span>
                  </>
                )}
              </div>
            </div>
          </li>
        ))}
      </ol>
      {hidden > 0 && (
        <button
          type="button"
          className="task-status-history-toggle"
          onClick={() => setExpanded(true)}
        >
          הצג עוד ({hidden})
        </button>
      )}
      {expanded && sorted.length > DEFAULT_VISIBLE && (
        <button
          type="button"
          className="task-status-history-toggle"
          onClick={() => setExpanded(false)}
        >
          הצג פחות
        </button>
      )}
    </div>
  );
}

function labelFor(s: WorkTaskStatus | string): string {
  if (s in STATUS_LABELS) return STATUS_LABELS[s as WorkTaskStatus];
  return String(s);
}

function shortName(email: string): string {
  if (!email) return "";
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

function formatTime(iso: string): string {
  if (!iso) return "";
  // Show "yyyy-mm-dd hh:mm" — same as the previous flat-list rendering
  // so users don't have to relearn the format. Drop seconds + tz.
  return iso.slice(0, 16).replace("T", " ");
}
