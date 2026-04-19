"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";

type Props = {
  assignees: { email: string; name: string; openCount: number }[];
  currentAssignee: string;
  showDone: boolean;
};

export default function FilterBar({
  assignees,
  currentAssignee,
  showDone,
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
        className={showDone ? "active" : ""}
        onClick={() => updateParam("done", showDone ? null : "1")}
      >
        {showDone ? "מציג הכל" : "כולל הושלמו"}
      </button>
      <span className="filter-sep" />
      <button
        type="button"
        className={!currentAssignee ? "active" : ""}
        onClick={() => updateParam("assignee", null)}
      >
        כל האחראים
      </button>
      {assignees.map((a) => (
        <button
          key={a.email}
          type="button"
          className={currentAssignee === a.email ? "active" : ""}
          onClick={() => updateParam("assignee", a.email)}
          title={a.email}
        >
          {a.name} <span className="count-inline">{a.openCount}</span>
        </button>
      ))}
    </div>
  );
}
