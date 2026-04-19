"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * Small red-dot badge next to the "תיוגים" link in the top nav. Fetches
 * the open-mentions count client-side on mount so the layout stays a fast
 * server component.
 *
 * Refreshes whenever the pathname changes — that catches the common flow
 * of "open inbox → resolve a mention → click a project → count should
 * drop". Not realtime, but no websockets needed.
 */
export default function NavMentionBadge() {
  const pathname = usePathname();
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/mentions/count", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { openCount?: number };
        if (!cancelled) setCount(data.openCount ?? 0);
      } catch {
        // Silent — a missing badge is strictly better than a noisy error.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  if (count === null || count <= 0) return null;

  return (
    <span
      className="nav-badge"
      aria-label={`${count} תיוגים פתוחים`}
      title={`${count} תיוגים פתוחים`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
