"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";

type Props = {
  projects: string[];
  currentProject: string;
  showResolved: boolean;
};

export default function InboxFilterBar({
  projects,
  currentProject,
  showResolved,
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
        className={showResolved ? "active" : ""}
        onClick={() => updateParam("resolved", showResolved ? null : "1")}
      >
        {showResolved ? "מציג הכל" : "כולל סגורים"}
      </button>
      <span className="filter-sep" />
      <select
        value={currentProject}
        onChange={(e) => updateParam("project", e.target.value || null)}
        className="inbox-project-select"
      >
        <option value="">כל הפרויקטים</option>
        {projects.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
    </div>
  );
}
