"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";

type Props = {
  currentKind: string; // "" | "comment" | "task"
  showResolved: boolean;
  counts: { all: number; comments: number; tasks: number };
};

export default function TimelineFilterBar({
  currentKind,
  showResolved,
  counts,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function updateParam(key: string, value: string | null) {
    const p = new URLSearchParams(searchParams.toString());
    if (value === null || value === "") p.delete(key);
    else p.set(key, value);
    const qs = p.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  return (
    <div className="filter-bar">
      <button
        type="button"
        className={currentKind === "" ? "active" : ""}
        onClick={() => updateParam("kind", null)}
      >
        הכל <span className="count-inline">{counts.all}</span>
      </button>
      <button
        type="button"
        className={currentKind === "comment" ? "active" : ""}
        onClick={() => updateParam("kind", "comment")}
      >
        הערות <span className="count-inline">{counts.comments}</span>
      </button>
      <button
        type="button"
        className={currentKind === "task" ? "active" : ""}
        onClick={() => updateParam("kind", "task")}
      >
        משימות <span className="count-inline">{counts.tasks}</span>
      </button>
      <span className="filter-sep" />
      <button
        type="button"
        className={showResolved ? "active" : ""}
        onClick={() => updateParam("resolved", showResolved ? null : "1")}
      >
        {showResolved ? "מציג הכל" : "כולל סגורים"}
      </button>
    </div>
  );
}
