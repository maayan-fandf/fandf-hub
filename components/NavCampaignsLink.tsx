"use client";

import ActiveLink from "./ActiveLink";
import { useEffect, useState } from "react";

/**
 * "📢 קמפיינים" topnav link — visible to admins, managers, and media
 * roles only. Designers / copywriters / illustrators / other internal
 * staff don't see the link. Gate is delivered by /api/me's
 * `canSeeCampaigns` field, which is computed server-side via
 * `canSeeCampaigns()` in lib/userRole.ts so the predicate stays in
 * one place. Replaces the old "☀️ בוקר" wording; the underlying
 * /morning route is unchanged so existing bookmarks + internal links
 * keep working.
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
  // Admin-gated 3rd menu item (🔮 תחזית חודש → /morning/forecast).
  // Same /api/me payload that decides whether to show the link at
  // all also carries isAdmin, so we don't pay for a second round-trip.
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function fetchOnce() {
      try {
        // Role-based gate — admins / managers / media roles only.
        // /api/me computes canSeeCampaigns server-side and returns the
        // boolean directly. The count endpoint enforces the same gate,
        // so the badge stays 0 for non-eligible users even if `show`
        // somehow flips true.
        const meRes = await fetch("/api/me", { cache: "no-store" });
        if (cancelled || !meRes.ok) return;
        const meData = (await meRes.json()) as {
          isAdmin?: boolean;
          isInternal?: boolean;
          canSeeCampaigns?: boolean;
        };
        if (cancelled) return;
        const eligible = !!meData.canSeeCampaigns;
        setShow(eligible);
        setIsAdmin(!!meData.isAdmin);
        if (!eligible) return;

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

  const badgeText = openCount > 99 ? "99+" : String(openCount);
  const badgeLabel = `${openCount} פרויקטים עם התראות`;

  return (
    // Mirrors the פרויקטים pattern: the trigger is a real link (click →
    // /morning, the alerts feed) and HOVER reveals a submenu offering
    // התראות + תקציבים. Reuses the projects-nav-* shell classes so it
    // inherits the same hover/focus-within dropdown behavior and the same
    // mobile graceful-degradation (on touch / ≤640px the dropdown is
    // suppressed and the trigger acts as a plain link to /morning).
    <div className="projects-nav-menu campaigns-nav-menu">
      <ActiveLink
        href="/morning"
        className="topnav-link projects-nav-trigger topnav-link-with-badge"
        aria-haspopup="menu"
        title={tooltip}
      >
        📢 קמפיינים
        <span className="projects-nav-chev" aria-hidden>
          ▾
        </span>
        {openCount > 0 && (
          <span className="nav-badge" aria-label={badgeLabel}>
            {badgeText}
          </span>
        )}
      </ActiveLink>
      <div className="projects-nav-dropdown campaigns-nav-dropdown" role="menu">
        <ActiveLink
          href="/morning"
          match="exact"
          className="campaigns-nav-item"
          role="menuitem"
        >
          <span className="campaigns-nav-item-icon" aria-hidden>
            🔔
          </span>
          <span className="campaigns-nav-item-label">התראות</span>
          {openCount > 0 && (
            <span className="nav-badge" aria-label={badgeLabel}>
              {badgeText}
            </span>
          )}
        </ActiveLink>
        <ActiveLink
          href="/morning/budgets"
          match="exact"
          className="campaigns-nav-item"
          role="menuitem"
        >
          <span className="campaigns-nav-item-icon" aria-hidden>
            💰
          </span>
          <span className="campaigns-nav-item-label">תקציבים</span>
        </ActiveLink>
        {/* Admin-only forecast entry — month-end spend prediction.
            Hidden for managers / media without admin so the dropdown
            stays tight for the people who don't need the predictive
            view. Same gate the page server-side enforces. */}
        {isAdmin && (
          <ActiveLink
            href="/morning/forecast"
            match="exact"
            className="campaigns-nav-item"
            role="menuitem"
          >
            <span className="campaigns-nav-item-icon" aria-hidden>
              🔮
            </span>
            <span className="campaigns-nav-item-label">תחזית חודש</span>
          </ActiveLink>
        )}
      </div>
    </div>
  );
}
