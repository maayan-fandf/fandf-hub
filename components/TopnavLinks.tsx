"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * Wraps the primary top-nav links (projects, tasks, campaigns,
 * notifications, …). On wide viewports the links flow inline as a
 * normal flex row. Below the nav's breakpoint the inline row is hidden
 * and a ☰ hamburger toggles the same links as a dropdown panel — so the
 * header collapses cleanly instead of wrapping into a ragged multi-row
 * block. The links are rendered once and reused in both modes (CSS
 * decides which presentation shows), so nothing is duplicated.
 *
 * Closes on route change, outside click, or Escape.
 */
export default function TopnavLinks({
  children,
}: {
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close the dropdown after navigating to a new route.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Outside-click + Escape to dismiss while open.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="topnav-links-wrap" ref={wrapRef}>
      <button
        type="button"
        className="topnav-hamburger"
        aria-label="תפריט ניווט"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden>☰</span>
      </button>
      <div className={`topnav-links${open ? " is-open" : ""}`}>{children}</div>
    </div>
  );
}
