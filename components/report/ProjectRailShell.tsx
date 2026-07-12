"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * Vertical-nav shell for the native project page. Replaces the "endless
 * scroll of cards + report-with-its-own-tabs" with one grouped side rail:
 * a persistent context/triage strip on top, a role-filtered rail on the
 * right (RTL), and a keep-alive content pane on the left.
 *
 * The server page builds the `sections` array (already filtered by role —
 * the client never receives content a client shouldn't see) and hands each
 * section's server-rendered node in as `content`. Active section mirrors to
 * the URL (`?section=`) via replaceState, and inactive panels stay mounted
 * behind FreezeWhenHidden so heavy charts don't re-render on switch — the
 * same pattern as the report tab shell.
 */

export type RailTone = "accent" | "danger" | "warning" | "success" | "neutral";

export type RailBadge = { text: string; tone: RailTone };

export type RailSection = {
  id: string;
  group: string;
  label: string;
  /** Emoji glyph (the project page speaks emoji elsewhere). */
  icon: string;
  badge?: RailBadge | null;
  content: ReactNode;
};

export type RailGroup = { id: string; label: string };

export type RailTriage = {
  /** Section id to jump to on click. */
  target: string;
  icon: string;
  text: string;
  tone: Exclude<RailTone, "neutral" | "success">;
};

/** Keep an inactive panel mounted, returning its last-active element so
 *  React bails out of reconciling hidden charts (same as the report tabs
 *  and StatsPageBody). */
function FreezeWhenHidden({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  const lastActive = useRef(children);
  if (active) lastActive.current = children;
  return <>{active ? children : lastActive.current}</>;
}

export default function ProjectRailShell({
  groups,
  sections,
  defaultSection,
  initialSection,
  triage = [],
}: {
  groups: RailGroup[];
  sections: RailSection[];
  defaultSection: string;
  initialSection?: string;
  triage?: RailTriage[];
}) {
  const validIds = new Set(sections.map((s) => s.id));
  const first =
    initialSection && validIds.has(initialSection)
      ? initialSection
      : validIds.has(defaultSection)
        ? defaultSection
        : sections[0]?.id;
  const [active, setActiveState] = useState<string>(first);

  const syncUrl = useCallback(
    (id: string) => {
      const params = new URLSearchParams(window.location.search);
      if (!id || id === defaultSection) params.delete("section");
      else params.set("section", id);
      const qs = params.toString();
      window.history.replaceState(
        null,
        "",
        qs ? `${window.location.pathname}?${qs}` : window.location.pathname,
      );
    },
    [defaultSection],
  );

  const setActive = useCallback(
    (id: string) => {
      if (!validIds.has(id)) return;
      setActiveState(id);
      syncUrl(id);
      requestAnimationFrame(() => {
        // Recharts' ResponsiveContainer measures on resize — nudge a
        // just-revealed panel so charts lay out at the right width.
        window.dispatchEvent(new Event("resize"));
        // On the mobile horizontal strip the active pill can sit off-screen
        // (e.g. after a triage-chip jump) — bring it into view so the
        // highlight is visible and the switch reads as having happened.
        document
          .querySelector(`.prl-rail [data-nav="${CSS.escape(id)}"]`)
          ?.scrollIntoView({ inline: "center", block: "nearest" });
      });
    },
    [syncUrl, validIds],
  );

  // Live-derived badges/triage read from the rendered (Suspense-streamed)
  // panels — surfaces "where's the fire" on the rail without blocking the
  // server sections on slow counts. Alerts: count the signal rows once
  // they stream in. Static server badges (e.g. the tasks count) still show
  // unless a derived rule overrides that id.
  const contentRef = useRef<HTMLDivElement>(null);
  const [derived, setDerived] = useState<Record<string, RailBadge | null>>({});
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    const recompute = () => {
      const next: Record<string, RailBadge | null> = {};
      const alerts = root.querySelector('[data-sid="alerts"]');
      if (alerts) {
        const n = alerts.querySelectorAll(".morning-signal-list > li").length;
        next.alerts = n > 0 ? { text: String(n), tone: "danger" } : null;
      }
      // פריסה: client requested changes (🔄) beats not-yet-approved (⏳);
      // both are actionable.
      const prisot = root.querySelector('[data-sid="prisot"]');
      if (prisot) {
        next.prisot = prisot.querySelector(".prisot-change-request-chip")
          ? { text: "🔄", tone: "warning" }
          : prisot.querySelector(".prisot-unapproved-badge")
            ? { text: "⏳", tone: "warning" }
            : null;
      }
      // מחירים: a published-price mismatch across surfaces (warn/severe pill).
      const prices = root.querySelector('[data-sid="prices"]');
      if (prices) {
        next.prices = prices.querySelector(
          ".price-check-status-warn, .price-check-status-severe",
        )
          ? { text: "⚠️", tone: "warning" }
          : null;
      }
      // Budget off its required pace (over/under) shows a red pace badge in
      // the header → flag סקירת פעילות.
      const overview = root.querySelector('[data-sid="overview"]');
      if (overview) {
        next.overview = overview.querySelector(".rpt-pace-badge.is-red")
          ? { text: "⚠️", tone: "warning" }
          : null;
      }
      setDerived((prev) => {
        const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
        for (const k of keys) {
          if ((prev[k]?.text ?? "") !== (next[k]?.text ?? "")) return next;
        }
        return prev;
      });
    };
    recompute();
    const mo = new MutationObserver(recompute);
    mo.observe(root, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);

  const badgeFor = (s: RailSection): RailBadge | null =>
    Object.prototype.hasOwnProperty.call(derived, s.id)
      ? derived[s.id]
      : (s.badge ?? null);

  const allTriage: RailTriage[] = [
    ...triage,
    ...(derived.alerts
      ? [
          {
            target: "alerts",
            icon: "🔥",
            text: `${derived.alerts.text} התראות`,
            tone: "danger" as const,
          },
        ]
      : []),
    ...(derived.prisot
      ? [
          {
            target: "prisot",
            icon: "📄",
            text:
              derived.prisot.text === "🔄"
                ? "פריסה — התבקשו שינויים"
                : "פריסה ממתינה לאישור",
            tone: "warning" as const,
          },
        ]
      : []),
    ...(derived.prices
      ? [
          {
            target: "prices",
            icon: "💰",
            text: "פערי מחירים בפרסום",
            tone: "warning" as const,
          },
        ]
      : []),
    ...(derived.overview
      ? [
          {
            target: "overview",
            icon: "⚠️",
            text: "תקציב לא בקצב",
            tone: "warning" as const,
          },
        ]
      : []),
  ];

  // Only render a group header when it actually has sections (role
  // filtering can empty a group out).
  const shownGroups = groups.filter((g) =>
    sections.some((s) => s.group === g.id),
  );

  return (
    <div className="prl">
      {allTriage.length > 0 && (
        <div className="prl-triage">
          <span className="prl-triage-lbl">דורש טיפול:</span>
          {allTriage.map((t, i) => (
            <button
              key={i}
              type="button"
              className={`prl-triage-chip is-${t.tone}`}
              onClick={() => setActive(t.target)}
            >
              <span aria-hidden>{t.icon}</span> {t.text}
            </button>
          ))}
        </div>
      )}
      <div className="prl-body">
        <nav className="prl-rail" aria-label="ניווט פרויקט">
          {shownGroups.map((g) => (
            <div key={g.id} className="prl-grp-block">
              <div className="prl-grp">{g.label}</div>
              {sections
                .filter((s) => s.group === g.id)
                .map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    data-nav={s.id}
                    className={"prl-nav" + (active === s.id ? " is-active" : "")}
                    aria-current={active === s.id ? "page" : undefined}
                    onClick={() => setActive(s.id)}
                  >
                    <span className="prl-nav-icon" aria-hidden>
                      {s.icon}
                    </span>
                    <span className="prl-nav-lbl">{s.label}</span>
                    {(() => {
                      const b = badgeFor(s);
                      return b ? (
                        <span className={`prl-bdg is-${b.tone}`}>{b.text}</span>
                      ) : null;
                    })()}
                  </button>
                ))}
            </div>
          ))}
        </nav>
        <div className="prl-content" ref={contentRef}>
          {sections.map((s) => (
            <div
              key={s.id}
              data-sid={s.id}
              className={"prl-panel" + (active === s.id ? " is-active" : "")}
              role="tabpanel"
              aria-hidden={active !== s.id}
            >
              <FreezeWhenHidden active={active === s.id}>
                {s.content}
              </FreezeWhenHidden>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
