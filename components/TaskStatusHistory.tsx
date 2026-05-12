"use client";

import { useState } from "react";
import { STATUS_LABELS } from "@/components/TaskStatusCell";
import type { TasksPerson, WorkTask, WorkTaskStatus } from "@/lib/appsScript";
import { personDisplayName } from "@/lib/personDisplay";
import { linkifyText, linkifyParagraphs } from "@/lib/linkify";

type Props = {
  history: WorkTask["status_history"];
  /** Description-edit snapshots (oldest first as stored on the row).
   *  Each entry is the body that USED TO be on the task before that
   *  point in time — so the most recent entry is what was there
   *  immediately before the current body. Empty / undefined when the
   *  task has never been edited or the sheet column doesn't exist yet. */
  descriptionHistory?: WorkTask["description_history"];
  /** People list for resolving `h.by` (email) to a Hebrew display
   *  name. Falls back to email-prefix when missing or empty. */
  people?: TasksPerson[];
};

const DEFAULT_VISIBLE = 3;

type StatusEvent = {
  kind: "status";
  at: string;
  by: string;
  from: string;
  to: string;
  note?: string;
};
type DescriptionEvent = {
  kind: "description";
  at: string;
  by: string;
  body: string;
  title?: string;
};
type Event = StatusEvent | DescriptionEvent;

/**
 * Vertical timeline view of a task's status changes AND description
 * edits, merged into a single chronological thread. Each entry shows
 * as a colored dot — status entries use the shared `tasks-status-dot-…`
 * palette (same hue as the status pill / kanban columns); description
 * entries use a neutral "✏️" dot with an expandable "show previous
 * version" toggle that reveals the body that was replaced.
 *
 * Auto-collapses to the last DEFAULT_VISIBLE events with a "הצג עוד"
 * toggle — most tasks accumulate many events over their lifetime and
 * the long tail is rarely useful day-to-day.
 *
 * Order: reverse-chronological (newest first). The audit-trail use
 * case is "what just happened?" — that lives at the top.
 */
export default function TaskStatusHistory({
  history,
  descriptionHistory,
  people,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  // Track which description-edit entries have their "previous version"
  // body revealed. Keyed by the entry's `at` timestamp (unique enough
  // per-task; two saves in the exact same second would collide but
  // the writer's `nowIso()` is millisecond-precise so this is safe).
  const [openBodies, setOpenBodies] = useState<Set<string>>(new Set());

  const events: Event[] = [
    ...(history || []).map(
      (h): StatusEvent => ({
        kind: "status",
        at: h.at,
        by: h.by,
        from: h.from,
        to: h.to,
        note: h.note,
      }),
    ),
    ...(descriptionHistory || []).map(
      (d): DescriptionEvent => ({
        kind: "description",
        at: d.at,
        by: d.by,
        body: d.body,
        title: d.title,
      }),
    ),
  ];

  if (events.length === 0) {
    return (
      <div className="task-status-history-empty">
        אין שינויים להצגה.
      </div>
    );
  }

  // Reverse-chronological by `at` so the newest event sits at the top.
  // Tie-breaker keeps the relative order of inputs stable — irrelevant
  // for distinct timestamps, harmless when they collide.
  const sorted = events
    .slice()
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const hidden = expanded ? 0 : Math.max(0, sorted.length - DEFAULT_VISIBLE);
  const visible = expanded ? sorted : sorted.slice(0, DEFAULT_VISIBLE);

  const toggleBody = (at: string) => {
    setOpenBodies((prev) => {
      const next = new Set(prev);
      if (next.has(at)) next.delete(at);
      else next.add(at);
      return next;
    });
  };

  return (
    <div className="task-status-history">
      {/*
        Direction indicator: the list is reverse-chronological (newest on
        top, oldest at the bottom), which isn't obvious at a glance.
        A small ↑ caption at the top makes the progression direction
        explicit so readers know "going up = forward in time".
      */}
      <div
        className="task-status-history-direction"
        title="חדש יותר למעלה · ישן יותר למטה"
        aria-label="הסטוריית הסטטוס מסודרת מהחדש לישן"
      >
        <span aria-hidden>↑</span>
        <span className="task-status-history-direction-label">חדש יותר</span>
      </div>
      <ol className="task-status-history-list">
        {visible.map((e, i) =>
          e.kind === "status" ? (
            <li
              key={`s-${e.at}-${i}`}
              // Note: we intentionally do NOT add `tasks-status-${h.to}`
              // here — that class is the shared status-pill color which
              // paints a light bg + dark text. On a list row it reads as
              // a glaring tan band on dark mode. The status info is
              // already carried by the colored dot (see the dot's
              // `tasks-status-dot-${h.to}` class below).
              className="task-status-history-item"
            >
              <span
                className={`task-status-history-dot tasks-status-dot-${e.to}`}
                aria-hidden
              />
              <div className="task-status-history-content">
                <div className="task-status-history-head">
                  {/*
                    DOM order is FROM → arrow → TO so the RTL flex flow
                    visually reads (right-to-left) as "FROM ← TO" — i.e.
                    the OLD state sits on the right where Hebrew readers
                    look first, the arrow points toward the NEW state on
                    the left. Previously the order was TO → arrow → FROM
                    which rendered as "TO ← FROM" — the arrow appeared
                    to point AT the old state, which felt backward.
                  */}
                  {e.from && (
                    <>
                      <span className="task-status-history-from">
                        {labelFor(e.from as WorkTaskStatus)}
                      </span>
                      <span
                        className="task-status-history-arrow"
                        aria-hidden
                      >
                        ←
                      </span>
                    </>
                  )}
                  <span
                    className={`task-status-history-status tasks-status-text-${e.to}`}
                  >
                    {labelFor(e.to as WorkTaskStatus)}
                  </span>
                </div>
                <div className="task-status-history-meta">
                  <time
                    dateTime={e.at}
                    className="task-status-history-time"
                    title={e.at}
                  >
                    {formatTime(e.at)}
                  </time>
                  {e.by && (
                    <>
                      <span aria-hidden>·</span>
                      <span
                        className="task-status-history-by"
                        title={e.by}
                      >
                        {personDisplayName(e.by, people)}
                      </span>
                    </>
                  )}
                  {e.note && (
                    <>
                      <span aria-hidden>·</span>
                      <span className="task-status-history-note">
                        {linkifyText(e.note)}
                      </span>
                    </>
                  )}
                </div>
              </div>
            </li>
          ) : (
            <li
              key={`d-${e.at}-${i}`}
              className="task-status-history-item task-status-history-item-desc"
            >
              <span
                className="task-status-history-dot task-status-history-dot-desc"
                aria-hidden
              >
                ✏️
              </span>
              <div className="task-status-history-content">
                <div className="task-status-history-head">
                  <span className="task-status-history-status">
                    {e.title ? "עריכת תיאור וכותרת" : "עריכת תיאור"}
                  </span>
                </div>
                <div className="task-status-history-meta">
                  <time
                    dateTime={e.at}
                    className="task-status-history-time"
                    title={e.at}
                  >
                    {formatTime(e.at)}
                  </time>
                  {e.by && (
                    <>
                      <span aria-hidden>·</span>
                      <span
                        className="task-status-history-by"
                        title={e.by}
                      >
                        {personDisplayName(e.by, people)}
                      </span>
                    </>
                  )}
                  <span aria-hidden>·</span>
                  <button
                    type="button"
                    className="task-status-history-desc-toggle"
                    aria-expanded={openBodies.has(e.at)}
                    onClick={() => toggleBody(e.at)}
                  >
                    {openBodies.has(e.at)
                      ? "הסתר גרסה קודמת"
                      : "הצג גרסה קודמת"}
                  </button>
                </div>
                {openBodies.has(e.at) && (
                  <div className="task-status-history-desc-prev">
                    {e.title && (
                      <div className="task-status-history-desc-prev-title">
                        <span className="task-status-history-desc-prev-label">
                          כותרת קודמת:
                        </span>{" "}
                        {e.title}
                      </div>
                    )}
                    <div className="task-status-history-desc-prev-body">
                      {linkifyParagraphs(e.body)}
                    </div>
                  </div>
                )}
              </div>
            </li>
          ),
        )}
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

function formatTime(iso: string): string {
  if (!iso) return "";
  // Show "yyyy-mm-dd hh:mm" — same as the previous flat-list rendering
  // so users don't have to relearn the format. Drop seconds + tz.
  return iso.slice(0, 16).replace("T", " ");
}
