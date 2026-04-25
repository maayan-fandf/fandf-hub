import Link from "next/link";

type View = "table" | "kanban";

type Props = {
  current: View;
  /** Existing search params on /tasks. We preserve everything except
   *  `view`, so toggling between table and kanban keeps the user's
   *  filters / role-defaults intact. */
  searchParams: Record<string, string | undefined>;
};

/**
 * Segmented control next to the page title that switches the queue
 * between the table and the kanban board. Pure server component — both
 * options are plain links so the choice persists in the URL and survives
 * full reloads (which the inline status pill triggers on writes).
 */
export default function TasksViewToggle({ current, searchParams }: Props) {
  const tableHref = buildHref(searchParams, { view: "" });
  const kanbanHref = buildHref(searchParams, { view: "kanban" });
  return (
    <div className="tasks-view-toggle" role="tablist" aria-label="תצוגה">
      <Link
        href={tableHref}
        className={`tasks-view-toggle-btn${current === "table" ? " is-active" : ""}`}
        aria-current={current === "table" ? "page" : undefined}
      >
        <span aria-hidden>📋</span>
        רשימה
      </Link>
      <Link
        href={kanbanHref}
        className={`tasks-view-toggle-btn${current === "kanban" ? " is-active" : ""}`}
        aria-current={current === "kanban" ? "page" : undefined}
      >
        <span aria-hidden>🗂️</span>
        קנבן
      </Link>
    </div>
  );
}

function buildHref(
  current: Record<string, string | undefined>,
  overrides: Record<string, string>,
): string {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(current)) {
    if (v) merged[k] = v;
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === "") delete merged[k];
    else merged[k] = v;
  }
  const qs = new URLSearchParams(merged).toString();
  return qs ? `/tasks?${qs}` : "/tasks";
}
