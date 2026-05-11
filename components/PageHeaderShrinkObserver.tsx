"use client";

import { useEffect } from "react";

/**
 * Tiny scroll watcher mounted inside a `.page-header` so the header can
 * shrink as the user scrolls deep into the page. Keeps the page-level
 * controls (project name, action buttons, month picker) reachable
 * without scrolling back up.
 *
 * Behaviour: when window.scrollY crosses THRESHOLD, toggle `is-scrolled`
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
const THRESHOLD = 80; // px — the project name barely moves before flipping

export default function PageHeaderShrinkObserver() {
  useEffect(() => {
    // Find the parent .page-header. Robust to wrapper changes — we
    // hop up from this component's mount point until we find a header
    // with the right class. Falls back to the first .page-header in
    // the document if traversal misses.
    let header: HTMLElement | null = null;
    const sentinel = document.querySelector<HTMLElement>(
      "[data-page-header-shrink-sentinel]",
    );
    if (sentinel) {
      header = sentinel.closest<HTMLElement>(".page-header");
    }
    if (!header) {
      header = document.querySelector<HTMLElement>(".page-header");
    }
    if (!header) return;

    let isScrolled = false;
    function onScroll() {
      const shouldShrink = window.scrollY > THRESHOLD;
      if (shouldShrink !== isScrolled) {
        isScrolled = shouldShrink;
        header?.classList.toggle("is-scrolled", shouldShrink);
      }
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll(); // sync state on mount (e.g. after a soft refresh that
                // preserves scroll position)
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return <span data-page-header-shrink-sentinel hidden aria-hidden />;
}
