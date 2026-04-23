"use client";

import ActiveLink from "./ActiveLink";
import { useEffect, useState } from "react";

/**
 * Shows the "ניהול" nav link only when the current user is an admin.
 * Fetched once on mount from /api/me (which reuses getMyProjects under
 * the hood). Silent on failure — a missing admin link is strictly better
 * than showing a broken/duplicate state.
 */
export default function NavAdminLink() {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/me", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { isAdmin?: boolean };
        if (!cancelled) setIsAdmin(!!data.isAdmin);
      } catch {
        /* swallow — link simply stays hidden */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!isAdmin) return null;

  return (
    <ActiveLink href="/admin" className="topnav-link">
      ⚙️ ניהול
    </ActiveLink>
  );
}
