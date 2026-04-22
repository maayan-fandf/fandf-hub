"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";

type Props = {
  projects: string[];
  currentProject: string;
};

// Inbox filter — currently just the per-project dropdown. The old "include
// resolved" toggle was replaced by a collapsible archive below the main list,
// so resolved mentions are always one expand-click away without cluttering
// the default view.
export default function InboxFilterBar({
  projects,
  currentProject,
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
