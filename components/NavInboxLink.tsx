"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import ActiveLink from "./ActiveLink";

/**
 * Topnav "🏷️ תיוגי לקוח" / "🏷️ תיוגים שלי" link with self-hide when
 * count is 0. Mirrors NavMentionBadge's fetch shape (same endpoint,
 * same on-pathname-change refresh) — but wraps the entire <Link> so
 * the nav slot disappears when there's nothing to triage instead of
 * leaving a labeled-but-empty entry.
 *
 * One initial render returns null (preserved behavior — no
 * skeleton); the link pops in once the first count fetch resolves
 * with a positive value. /inbox is still reachable by URL.
 */
export default function NavInboxLink({ isClientUser }: { isClientUser: boolean }) {
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
        // Silent — missing nav slot beats noisy error.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  if (count === null || count <= 0) return null;

  return (
    <ActiveLink href="/inbox" className="topnav-link topnav-link-with-badge">
      🏷️ {isClientUser ? "תיוגים שלי" : "תיוגי לקוח"}
      <span
        className="nav-badge"
        aria-label={`${count} תיוגים פתוחים`}
        title={`${count} תיוגים פתוחים`}
      >
        {count > 99 ? "99+" : count}
      </span>
    </ActiveLink>
  );
}
