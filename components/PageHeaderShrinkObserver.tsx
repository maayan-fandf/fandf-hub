"use client";

import { useEffect, useRef } from "react";

/**
 * Tiny scroll watcher mounted inside a `.page-header` so the header can
 * shrink as the user scrolls deep into the page. Keeps the page-level
 * controls (project name, action buttons, month picker) reachable
 * without scrolling back up.
 *
 * Behaviour: when window.scrollY crosses a threshold, toggle `is-scrolled`
 * on the closest `.page-header` ancestor. CSS handles the actual
 * shrink (h1 font-size, hide subtitle, tighten padding) so this file
 * stays a passive class-toggle.
 *
 * Renders nothing visible — pure side-effect component. Mounted as a
 * sibling inside the header, not wrapping it, so the server-rendered
 * header keeps its existing structure for SSR.
 *
 * Only active on desktop (CSS gates sticky behavior at the same
 * breakpoint via @media). On mobile we leave the header non-sticky
 * because the viewport is too short to make shrinking pay off — the
 * full header out of view is better than a permanently-half-occluded
 * top bar.
 */
/* Two thresholds, not one — and the gap between them is load-bearing.
 *
 * Shrinking the header removes ~16px of document height above the fold, so
 * Chrome's scroll anchoring immediately scrolls BACK by the same amount to
 * keep the content visually still. With a single threshold that correction
 * lands the page below it again: un-shrink → anchoring pushes back up →
 * shrink → forever, at frame rate, for as long as the user rests anywhere
 * in the 16px band above it. Measured on /projects/נרקיסים at 1280px:
 * 90.4 → shrink → 74.4 → grow → 90.4 → shrink → … (Maayan, 2026-08-11 —
 * the header's action row visibly jittering).
 *
 * So the restore threshold has to sit further below the shrink threshold
 * than that correction is wide. 56px of gap leaves room for the header
 * gaining a row later without the oscillation coming back.
 */
const SHRINK_AT = 80; // px — the project name barely moves before flipping
const RESTORE_AT = 24; // px — effectively "back at the top"

export default function PageHeaderShrinkObserver() {
  const sentinelRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    // Find the parent .page-header by hopping up from THIS component's own
    // node (a ref, not a document query): while the page streams, the first
    // sentinel in the document can belong to a hidden copy React is about to
    // swap out, and a header found through it is one nobody sees — the rail
    // offset below was measured off such a node and never moved again.
    // Falls back to the first .page-header in the document if traversal
    // misses.
    let header: HTMLElement | null =
      sentinelRef.current?.closest<HTMLElement>(".page-header") ?? null;
    if (!header) {
      header = document.querySelector<HTMLElement>(".page-header");
    }
    if (!header) return;

    let isScrolled = false;
    function onScroll() {
      // Only the threshold for the state we're NOT in can flip us, so the
      // anchoring correction that follows a shrink can't flip us straight
      // back out of it.
      const y = window.scrollY;
      const shouldShrink = isScrolled ? y > RESTORE_AT : y > SHRINK_AT;
      if (shouldShrink !== isScrolled) {
        isScrolled = shouldShrink;
        header?.classList.toggle("is-scrolled", shouldShrink);
      }
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll(); // sync state on mount (e.g. after a soft refresh that
                // preserves scroll position)

    // The project page's side rail (.prl-rail) is sticky UNDER this header,
    // and its offset used to be a constant 7rem — right for a one-row
    // header, and wrong the moment the action row wraps: at 1100-1280px the
    // header runs to two rows and its bottom sat ~100px below the rail's
    // top, over the rail's first sections (measured 2026-09-28, after the
    // תצוגת לקוח toggle joined the row). So the offset follows the real
    // height of the sticky stack instead. `- 12` keeps the one-row layout
    // exactly where it was: 60px sticky top + 64px stack - 12 = the old 112.
    const stack = header.closest<HTMLElement>(".project-top-stack");
    const root = document.documentElement;
    let ro: ResizeObserver | null = null;
    if (stack && typeof ResizeObserver !== "undefined") {
      const place = () => {
        const cs = getComputedStyle(stack);
        if (cs.position !== "sticky") {
          root.style.removeProperty("--prl-rail-top");
          return;
        }
        const top = parseFloat(cs.top) || 0;
        const px = Math.round(top + stack.getBoundingClientRect().height - 12);
        root.style.setProperty("--prl-rail-top", `${px}px`);
      };
      ro = new ResizeObserver(place);
      ro.observe(stack);
      place();
    }
    return () => {
      window.removeEventListener("scroll", onScroll);
      ro?.disconnect();
      root.style.removeProperty("--prl-rail-top");
    };
  }, []);

  return <span ref={sentinelRef} data-page-header-shrink-sentinel hidden aria-hidden />;
}
