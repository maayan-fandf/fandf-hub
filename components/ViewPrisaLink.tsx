"use client";

import type { MouseEvent } from "react";

/**
 * "צפו בפריסה ↓" jump on the client approval banner
 * (ClientPrisaApprovalPrompt) — takes the client from the banner to the
 * פריסה אחרונה card.
 *
 * Why this isn't a plain <a href="#prisa-section">: the banner renders above
 * the report shell, and on the native report (clients since the 2026-07-27
 * cutover) the פריסות panel is `display: none` until its rail section is
 * active — `.prl-panel:not(.is-active)`. A hash link to a hidden element does
 * nothing at all: no scroll, no section switch, no feedback. So when the rail
 * is on the page we ask it to switch first (`hub:rail-section`, handled in
 * ProjectRailShell, which scrolls the anchor once the panel is visible).
 *
 * On the classic stacked layout (?report=classic) there's no rail and the
 * card is always in flow — we just scroll to it ourselves. The href stays put
 * so the link keeps working for middle-click / keyboard / no-JS.
 */
export default function ViewPrisaLink() {
  function jump(e: MouseEvent<HTMLAnchorElement>) {
    // Let modified clicks (new tab / window) fall through to the browser.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (document.querySelector('.prl-panel[data-sid="prisot"]')) {
      window.dispatchEvent(
        new CustomEvent("hub:rail-section", {
          detail: { section: "prisot", anchor: "prisa-section" },
        }),
      );
      return;
    }
    document
      .getElementById("prisa-section")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <a
      href="#prisa-section"
      className="client-approve-prompt-view"
      onClick={jump}
    >
      צפו בפריסה ↓
    </a>
  );
}
