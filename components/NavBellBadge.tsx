"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * Small red-dot badge next to the "🔔 התראות" link in the top nav.
 * Mirrors NavMentionBadge — fetches the unread count client-side on
 * mount + path change, so the layout stays a fast server component
 * and we get the "open notifications → mark read → count drops" flow
 * for free.
 *
 * Snooze handling: when the user has snoozed via the gear menu, the
 * count still gets fetched (so the underlying number stays accurate)
 * but the visible badge dims to a muted color. The user can still
 * see "you have N waiting" without the red-dot urgency.
 */
export default function NavBellBadge() {
  const pathname = usePathname();
  const [count, setCount] = useState<number | null>(null);
  const [snoozed, setSnoozed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/notifications/count", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as {
          count?: number;
          snoozedUntil?: string;
        };
        if (cancelled) return;
        setCount(data.count ?? 0);
        setSnoozed(!!data.snoozedUntil);
      } catch {
        /* missing badge is strictly better than a noisy error */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  if (count === null || count <= 0) return null;

  return (
    <span
      className={`nav-badge${snoozed ? " is-snoozed" : ""}`}
      aria-label={`${count} התראות חדשות${snoozed ? " (מושתק)" : ""}`}
      title={`${count} התראות חדשות${snoozed ? " · התראות מושתקות זמנית" : ""}`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
