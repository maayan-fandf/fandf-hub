"use client";

import ActiveLink from "./ActiveLink";
import { useEffect, useState } from "react";

/**
 * "📢 קמפיינים" topnav link — internal-only (admin or @fandf.co.il).
 * Replaces the old "☀️ בוקר" wording; the underlying /morning route
 * is unchanged so existing bookmarks + internal links keep working.
 *
 * Badge shows the count of projects with open alerts (severe + warn
 * + info) so internal staff see at-a-glance how many need attention
 * without opening the page. Tooltip breaks that down by urgency:
 *   🔥 קריטיים: N · ⚠️ אזהרות: N · ℹ️ מידע: N · ✅ שקט: N
 *
 * Lazy-load posture: fetch on mount + on tab focus only — NO
 * polling interval. The /api/morning/count endpoint is backed by
 * the existing 60s server-side cache on getMorningFeed, so even with
 * many users the upstream Apps Script call is bounded. Polling on a
 * timer would defeat that cache and re-hit Apps Script per badge
 * instance per minute, which is exactly the throttling the user
 * called out.
 */

type MorningCounts = {
  total: number;
  severe: number;
  warn: number;
  info: number;
  clear: number;
};

const ZERO: MorningCounts = {
  total: 0,
  severe: 0,
  warn: 0,
  info: 0,
  clear: 0,
};

export default function NavCampaignsLink() {
  const [show, setShow] = useState<boolean | null>(null);
  const [counts, setCounts] = useState<MorningCounts>(ZERO);

  useEffect(() => {
    let cancelled = false;
    async function fetchOnce() {
      try {
        // Internal/admin gate — keep the same source as the legacy
        // NavMorningLink (one /api/me round-trip on mount). The count
        // endpoint also enforces this server-side, so the badge stays
        // 0 for non-internal users even if `show` somehow flips true.
        const meRes = await fetch("/api/me", { cache: "no-store" });
        if (cancelled || !meRes.ok) return;
        const meData = (await meRes.json()) as {
          isAdmin?: boolean;
          isInternal?: boolean;
        };
        if (cancelled) return;
        const isInternal = !!(meData.isAdmin || meData.isInternal);
        setShow(isInternal);
        if (!isInternal) return;

        const countRes = await fetch("/api/morning/count", {
          cache: "no-store",
        });
        if (cancelled || !countRes.ok) return;
        const data = (await countRes.json()) as { counts?: MorningCounts };
        if (!cancelled) setCounts(data.counts ?? ZERO);
      } catch {
        // Silent — missing badge is better than a noisy error.
      }
    }
    fetchOnce();
    function onFocus() {
      // Re-fetch on tab focus so the badge picks up signal
      // resolutions from another tab without needing to navigate.
      fetchOnce();
    }
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  if (!show) return null;

  // Tooltip composition — show only non-zero buckets so the title
  // stays scannable. Total always present so users see the scope.
  const breakdown: string[] = [];
  if (counts.severe > 0) breakdown.push(`🔥 ${counts.severe} קריטיים`);
  if (counts.warn > 0) breakdown.push(`⚠️ ${counts.warn} אזהרות`);
  if (counts.info > 0) breakdown.push(`ℹ️ ${counts.info} מידע`);
  if (counts.clear > 0) breakdown.push(`✅ ${counts.clear} שקט`);
  const tooltipBase = `${counts.total} פרויקטים`;
  const tooltip = breakdown.length
    ? `${tooltipBase}\n${breakdown.join(" · ")}`
    : tooltipBase;

  // Open-items count = severe + warn + info (anything not clear).
  // Don't include `clear` in the badge — those are already tidy.
  const openCount = counts.severe + counts.warn + counts.info;

  return (
    <ActiveLink
      href="/morning"
      className="topnav-link topnav-link-with-badge"
      title={tooltip}
    >
      📢 קמפיינים
      {openCount > 0 && (
        <span
          className="nav-badge"
          aria-label={`${openCount} פרויקטים עם התראות`}
        >
          {openCount > 99 ? "99+" : openCount}
        </span>
      )}
    </ActiveLink>
  );
}
