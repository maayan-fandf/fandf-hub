"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * "☀️ בוקר" nav link — visible only to internal staff (admin or
 * @fandf.co.il email). External clients who have hub access via the
 * Email Client column don't see it; the morning page is internal-only.
 * Fetched once on mount from /api/me.
 */
export default function NavMorningLink() {
  const [show, setShow] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/me", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as {
          isAdmin?: boolean;
          isInternal?: boolean;
        };
        if (!cancelled) setShow(!!(data.isAdmin || data.isInternal));
      } catch {
        /* stay hidden on error */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!show) return null;

  return (
    <Link href="/morning" className="topnav-link">
      ☀️ בוקר
    </Link>
  );
}
