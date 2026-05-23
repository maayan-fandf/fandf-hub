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
  copyAmount = true,
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
  /** When false, the `amount` is NOT written to the clipboard — used by
   *  the "open the account" buttons, which shouldn't clobber the clipboard
   *  with the budget number (a `copyId` slug, if given, is still copied so
   *  the platform's campaign filter can be pasted). Defaults to true. */
  copyAmount?: boolean;
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
        if (copyAmount && copyId) {
          // budget first, gap, then id last (id = current clipboard).
          await copyOne(amount);
          await new Promise((r) => setTimeout(r, 300));
          await copyOne(copyId);
        } else if (copyAmount) {
          await copyOne(amount);
        } else if (copyId) {
          await copyOne(copyId);
        }
        // Only flash "copied" when something actually went to the clipboard
        // (an open-only button with copyAmount=false and no copyId doesn't).
        if (copyAmount || copyId) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        }
        if (url) window.open(url, "_blank", "noopener");
      }}
      title={
        !copyAmount
          ? copyId
            ? "פותח את הפלטפורמה ומעתיק את מזהה הקמפיין לסינון"
            : "פותח את הפלטפורמה"
          : url
            ? "מעתיק את הסכום ופותח את הפלטפורמה"
            : "מעתיק את הסכום ללוח"
      }
    >
      {copied ? "✓ הועתק" : label ?? `📋 העתק ₪${amount}`}
    </button>
  );
}
