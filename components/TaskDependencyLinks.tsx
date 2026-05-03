import Link from "next/link";
import type { WorkTask, WorkTaskStatus } from "@/lib/appsScript";
import {
  STATUS_LABELS,
  STATUS_EMOJIS,
} from "@/components/TaskStatusCell";

/**
 * Side-panel dependency block for /tasks/[id]. Renders two lists:
 *
 *   ממתין על:  upstream tasks blocking this one (task.blocked_by)
 *   חוסם:      downstream tasks this one is blocking (task.blocks)
 *
 * Each entry is a clickable link to the related task with its status
 * emoji + title + status label so users can scan the chain state at
 * a glance. If the related task wasn't found in the lookup (deleted /
 * inaccessible / different project), we render the bare ID as a
 * non-link with a "(לא נמצא)" suffix.
 *
 * Self-rendering: returns null when both arrays are empty, so the
 * caller doesn't need to check before mounting.
 *
 * Phase 6a of dependencies feature, 2026-05-03.
 */
export default function TaskDependencyLinks({
  task,
  lookup,
}: {
  task: WorkTask;
  /** Map of taskId → minimal task fields for related-row rendering.
   *  Built by the caller from a project-wide tasksList; only entries
   *  for IDs in task.blocks ∪ task.blocked_by are actually used. */
  lookup: Map<string, { title: string; status: WorkTaskStatus }>;
}) {
  const upstream = task.blocked_by || [];
  const downstream = task.blocks || [];
  if (upstream.length === 0 && downstream.length === 0) return null;

  return (
    <div className="task-detail-side-deps">
      {upstream.length > 0 && (
        <div className="task-detail-deps-block">
          <div className="task-detail-deps-label">🔒 ממתין על:</div>
          <ul className="task-detail-deps-list">
            {upstream.map((id) => (
              <DepRow key={id} id={id} info={lookup.get(id)} />
            ))}
          </ul>
        </div>
      )}
      {downstream.length > 0 && (
        <div className="task-detail-deps-block">
          <div className="task-detail-deps-label">⛓️ חוסם:</div>
          <ul className="task-detail-deps-list">
            {downstream.map((id) => (
              <DepRow key={id} id={id} info={lookup.get(id)} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function DepRow({
  id,
  info,
}: {
  id: string;
  info: { title: string; status: WorkTaskStatus } | undefined;
}) {
  if (!info) {
    // Related task not in lookup — surface the ID so admins can
    // diagnose the dangling reference. Wrapping in a link still works
    // (the task page will 404 with a meaningful message).
    return (
      <li className="task-detail-deps-row task-detail-deps-row-missing">
        <Link href={`/tasks/${encodeURIComponent(id)}`}>{id}</Link>
        <span className="task-detail-deps-missing-tag">(לא נמצא)</span>
      </li>
    );
  }
  return (
    <li className={`task-detail-deps-row tasks-status-${info.status}`}>
      <span className="task-detail-deps-emoji" aria-hidden>
        {STATUS_EMOJIS[info.status] ?? "·"}
      </span>
      <Link
        href={`/tasks/${encodeURIComponent(id)}`}
        className="task-detail-deps-title"
      >
        {info.title || id}
      </Link>
      <span
        className={`tasks-status-cell-btn tasks-status-${info.status}`}
        title={STATUS_LABELS[info.status] ?? info.status}
      >
        {STATUS_LABELS[info.status] ?? info.status}
      </span>
    </li>
  );
}
