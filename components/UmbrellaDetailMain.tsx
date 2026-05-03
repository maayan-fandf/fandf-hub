import Link from "next/link";
import type { WorkTask } from "@/lib/appsScript";
import {
  STATUS_LABELS,
  STATUS_EMOJIS,
} from "@/components/TaskStatusCell";
import { deriveUmbrellaProgress } from "@/lib/umbrellaStatus";

/**
 * Detail-page body for an umbrella container task. Replaces the
 * normal `task-detail-main` content (discussion / history / files
 * sections) when `is_umbrella=true`. Renders:
 *   - Aggregate progress badge ("2 / 4 ✓")
 *   - Child list (one row per child, sorted by status priority then
 *     created_at), each row links to its own /tasks/[id] for
 *     drill-down + has the standard status pill emoji
 *   - Empty-state when no children exist yet
 *
 * Phase 4b of dependencies feature, 2026-05-03. The "+ הוסף שלב"
 * button is intentionally NOT here — chain-creation flow lands in
 * phase 5 with its own picker UI.
 */
export default function UmbrellaDetailMain({
  umbrella,
  children,
}: {
  umbrella: WorkTask;
  children: WorkTask[];
}) {
  const progress = deriveUmbrellaProgress(
    children.map((c) => c.status),
  );

  // Sort: active steps first (in_progress > awaiting_handling >
  // awaiting_clarification > awaiting_approval > blocked > draft > done > cancelled),
  // then by created_at within each bucket. Lower number sorts earlier.
  const ORDER: Record<string, number> = {
    in_progress: 1,
    awaiting_clarification: 2,
    awaiting_approval: 3,
    awaiting_handling: 4,
    blocked: 5,
    draft: 6,
    done: 8,
    cancelled: 9,
  };
  const sortedChildren = [...children].sort((a, b) => {
    const oa = ORDER[a.status] ?? 7;
    const ob = ORDER[b.status] ?? 7;
    if (oa !== ob) return oa - ob;
    return a.created_at.localeCompare(b.created_at);
  });

  return (
    <div className="task-detail-main">
      {umbrella.description && (
        <div className="task-detail-body">
          {umbrella.description.split("\n").map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>
      )}

      <section className="task-detail-section">
        <h3 className="umbrella-header-row">
          <span>📦 שרשרת</span>
          <span className="umbrella-progress" title="התקדמות שלבים">
            {progress.displayHe}
            {progress.cancelled > 0 && (
              <span className="umbrella-cancelled-count">
                {" "}({progress.cancelled} בוטלו)
              </span>
            )}
          </span>
        </h3>

        {sortedChildren.length === 0 ? (
          <p className="task-detail-empty">
            אין שלבים בשרשרת. צור שלב חדש כדי להתחיל.
          </p>
        ) : (
          <ol className="umbrella-children-list">
            {sortedChildren.map((c) => (
              <li
                key={c.id}
                className={`umbrella-child-row tasks-status-${c.status}`}
              >
                <span className="umbrella-child-status" aria-hidden>
                  {STATUS_EMOJIS[c.status] ?? "·"}
                </span>
                <Link
                  href={`/tasks/${encodeURIComponent(c.id)}`}
                  className="umbrella-child-title"
                >
                  {c.title || `(ללא כותרת — ${c.id})`}
                </Link>
                <span
                  className={`tasks-status-cell-btn tasks-status-${c.status}`}
                  title={STATUS_LABELS[c.status] ?? c.status}
                >
                  {STATUS_LABELS[c.status] ?? c.status}
                </span>
                {c.assignees && c.assignees.length > 0 && (
                  <span className="umbrella-child-assignees">
                    {c.assignees
                      .map((a) => a.split("@")[0])
                      .join(", ")}
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
