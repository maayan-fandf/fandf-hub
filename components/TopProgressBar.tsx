"use client";

import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

// Thin 2px progress bar at the top of the viewport that fills during
// navigation and fades out when it completes. Pattern mimics nprogress
// (GitHub / YouTube / Linear) — grows slowly while loading, then snaps
// to full + fades so completion feels snappy.
//
// Detection strategy:
//   - START  → global click on any internal <a href="/..."> link
//   - STOP   → pathname or searchParams changes (= Next.js finished the
//              route transition and rendered the new page / loading.tsx)
//
// Why not `router.events` (Pages Router)? App Router removed that API;
// there's no official global navigation event. Clicks on <Link> are the
// closest proxy. Programmatic `router.push()` calls bypass this — if we
// need coverage there later, expose a `useProgressBar()` context hook.
export default function TopProgressBar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [state, setState] = useState<"idle" | "loading" | "complete">("idle");

  // START on any click of an internal link. We intentionally don't try to
  // detect whether the click will actually cause navigation — false
  // positives (click a link that goes to the same URL) just flash the
  // bar briefly, which is harmless.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // open-in-new-tab
      if (e.button !== 0) return; // not primary click
      const anchor = (e.target as HTMLElement | null)?.closest?.("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href) return;
      // External / hash / special schemes — browser handles these, no
      // client-side route transition.
      if (href.startsWith("#")) return;
      if (/^(https?:|mailto:|tel:)/.test(href)) return;
      if (anchor.getAttribute("target") === "_blank") return;
      setState("loading");
    };
    document.addEventListener("click", onClick, { capture: true });
    return () => document.removeEventListener("click", onClick, { capture: true });
  }, []);

  // STOP when pathname or search params change — the new page has
  // rendered. Transition through "complete" so CSS can snap to 100% + fade.
  useEffect(() => {
    if (state !== "loading") return;
    setState("complete");
    const t = setTimeout(() => setState("idle"), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, searchParams]);

  // Safety net: if a nav fails silently (no pathname change), auto-hide
  // after a long timeout so the bar doesn't hang visible forever.
  useEffect(() => {
    if (state !== "loading") return;
    const t = setTimeout(() => setState("idle"), 15000);
    return () => clearTimeout(t);
  }, [state]);

  return (
    <div
      className={`top-progress top-progress-${state}`}
      aria-hidden
      role="progressbar"
    />
  );
}
