"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";

type Props = {
  showResolved: boolean;
  resolvedCount: number;
};

// Single "הצג סגורים" toggle at the top of a project overview page — flips
// all three previews (tasks / mentions / comments) between open-only and
// open+resolved. Mirrors the Inbox's InboxFilterBar affordance so the
// pattern is consistent across the hub.
export default function ProjectFilterBar({
  showResolved,
  resolvedCount,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function toggle() {
    const p = new URLSearchParams(searchParams.toString());
    if (showResolved) p.delete("resolved");
    else p.set("resolved", "1");
    const qs = p.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  return (
    <div className="filter-bar">
      <button
        type="button"
        className={showResolved ? "active" : ""}
        onClick={toggle}
        title={
          showResolved
            ? "הסתר פריטים שנפתרו"
            : resolvedCount > 0
              ? `הצג גם ${resolvedCount} פריטים שנפתרו (משימות, תיוגים, הערות)`
              : "הצג גם פריטים שנפתרו"
        }
      >
        {showResolved
          ? "🙈 הסתר סגורים"
          : resolvedCount > 0
            ? `👁️ הצג סגורים (${resolvedCount})`
            : "👁️ הצג סגורים"}
      </button>
    </div>
  );
}
