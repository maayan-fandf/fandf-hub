"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";

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
      // Recharts' ResponsiveContainer measures on resize — nudge a
      // just-revealed panel so charts lay out at the right width.
      requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    },
    [syncUrl, validIds],
  );

  // Only render a group header when it actually has sections (role
  // filtering can empty a group out).
  const shownGroups = groups.filter((g) =>
    sections.some((s) => s.group === g.id),
  );

  return (
    <div className="prl">
      {triage.length > 0 && (
        <div className="prl-triage">
          <span className="prl-triage-lbl">דורש טיפול:</span>
          {triage.map((t, i) => (
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
                    className={"prl-nav" + (active === s.id ? " is-active" : "")}
                    aria-current={active === s.id ? "page" : undefined}
                    onClick={() => setActive(s.id)}
                  >
                    <span className="prl-nav-icon" aria-hidden>
                      {s.icon}
                    </span>
                    <span className="prl-nav-lbl">{s.label}</span>
                    {s.badge && (
                      <span className={`prl-bdg is-${s.badge.tone}`}>
                        {s.badge.text}
                      </span>
                    )}
                  </button>
                ))}
            </div>
          ))}
        </nav>
        <div className="prl-content">
          {sections.map((s) => (
            <div
              key={s.id}
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
