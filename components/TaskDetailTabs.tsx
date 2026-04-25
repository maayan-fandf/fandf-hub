"use client";

import { useEffect, useState } from "react";

/**
 * Sticky in-page tab strip for `/tasks/[id]`. Three jump-links to the
 * page's main sections — דיון / היסטוריה / קבצים — that stay pinned to
 * the top of the content card as the user scrolls past the description
 * body.
 *
 * Two parts:
 * 1. Smooth-scroll on click: tabs anchor-jump to their target section
 *    via scrollIntoView. Section IDs are owned by the page (the section
 *    elements get `id="task-discussion"` etc. server-side).
 * 2. Active highlight on scroll: an IntersectionObserver tracks which
 *    section is closest to the top of the viewport and highlights the
 *    matching tab. The rootMargin tunes "closest" — top: -25% means the
 *    section becomes active once its top crosses 25% down the viewport,
 *    which feels natural without flicker.
 *
 * Renders nothing on initial SSR — IntersectionObserver runs only in
 * the browser and the active state is purely a UX hint.
 */
type Tab = { id: string; label: string };

const TABS: Tab[] = [
  { id: "task-discussion", label: "💬 דיון" },
  { id: "task-history", label: "🕒 היסטוריה" },
  { id: "task-files", label: "📁 קבצים" },
];

export default function TaskDetailTabs() {
  const [active, setActive] = useState<string>(TABS[0].id);

  useEffect(() => {
    const sections = TABS.map((t) => document.getElementById(t.id)).filter(
      (el): el is HTMLElement => el != null,
    );
    if (sections.length === 0) return;

    // Picking the topmost intersecting section as "active" — that maps
    // to the section the user is currently reading. The asymmetric
    // rootMargin (top -25%, bottom -60%) means a section is "active"
    // when its top is between 25% and 40% down the viewport, which is
    // where most readers' eyes land.
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort(
            (a, b) =>
              a.boundingClientRect.top - b.boundingClientRect.top,
          );
        if (visible.length > 0) {
          setActive(visible[0].target.id);
        }
      },
      { rootMargin: "-25% 0px -60% 0px", threshold: 0 },
    );
    for (const s of sections) observer.observe(s);
    return () => observer.disconnect();
  }, []);

  function jumpTo(id: string) {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    // Preserve clicked-tab highlight even before the IntersectionObserver
    // catches up — the smooth-scroll takes ~300ms and the observer fires
    // mid-scroll, so without this the highlight visibly bounces.
    setActive(id);
  }

  return (
    <nav className="task-detail-tabs" aria-label="ניווט בתוך המשימה">
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`task-detail-tab${active === t.id ? " is-active" : ""}`}
          onClick={() => jumpTo(t.id)}
          aria-current={active === t.id ? "true" : undefined}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}
