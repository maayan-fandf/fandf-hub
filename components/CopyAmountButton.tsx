"use client";

import { useState } from "react";

/* Small button that copies a numeric amount to the clipboard and optionally
   opens a deep-link. Used on morning-dashboard signals where a campaign
   manager wants to paste a planned daily-budget into the platform UI. */
export default function CopyAmountButton({
  amount,
  label,
  url,
  variant = "primary",
  copyId,
}: {
  amount: string;
  label?: string;
  url?: string;
  variant?: "primary" | "ghost";
  /** Campaign id (slug). When set, the clipboard ends up with TWO
   *  history items: the budget (written first) and the id (written
   *  LAST, so the id is the CURRENT clipboard — paste it into the
   *  platform's campaign filter first, then grab the budget from
   *  clipboard history for the budget field). */
  copyId?: string;
}) {
  const [copied, setCopied] = useState(false);
  const className =
    variant === "primary" ? "morning-copy-btn" : "morning-copy-btn ghost";
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        // Two SEPARATE clipboard-history items: the budget first, then the
        // campaign id LAST so the id is the CURRENT clipboard (paste into
        // the platform's campaign filter first; the budget stays in
        // clipboard history for the budget field).
        //
        // Async Clipboard API (reliable on the desk; execCommand is
        // limited to one copy per gesture, which is why two execCommand
        // calls copied nothing). A real gap between the writes lets the OS
        // clipboard history register the budget as its own item before the
        // id overwrites the live clipboard. The URL opens LAST (still
        // within the gesture's activation window) so focus isn't stolen.
        const copyOne = async (val: string): Promise<void> => {
          try {
            if (navigator.clipboard?.writeText) {
              await navigator.clipboard.writeText(val);
              return;
            }
          } catch {
            /* fall through to execCommand */
          }
          try {
            const ta = document.createElement("textarea");
            ta.value = val;
            ta.style.position = "fixed";
            ta.style.top = "0";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
          } catch {
            /* best-effort */
          }
        };
        if (copyId) {
          // budget first, gap, then id last (id = current clipboard).
          await copyOne(amount);
          await new Promise((r) => setTimeout(r, 300));
          await copyOne(copyId);
        } else {
          await copyOne(amount);
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
        if (url) window.open(url, "_blank", "noopener");
      }}
      title={
        url
          ? "מעתיק את הסכום ופותח את הפלטפורמה"
          : "מעתיק את הסכום ללוח"
      }
    >
      {copied ? "✓ הועתק" : label ?? `📋 העתק ₪${amount}`}
    </button>
  );
}
