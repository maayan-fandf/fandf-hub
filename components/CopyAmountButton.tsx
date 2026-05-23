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
  copyFirst,
}: {
  amount: string;
  label?: string;
  url?: string;
  variant?: "primary" | "ghost";
  /** When set, this value is copied to the clipboard BEFORE `amount`, so
   *  the OS/Chrome clipboard history holds both (e.g. the campaign id to
   *  paste into the platform's campaign filter, then the daily budget to
   *  paste into the budget field). The clipboard ends on `amount`. */
  copyFirst?: string;
}) {
  const [copied, setCopied] = useState(false);
  const className =
    variant === "primary" ? "morning-copy-btn" : "morning-copy-btn ghost";
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        // Copy the slug and the budget as TWO SEPARATE clipboard entries
        // so the OS/Chrome clipboard history shows each on its own — paste
        // the campaign id into the platform's campaign filter, then the
        // daily budget into the budget field.
        //
        // Use the async Clipboard API (reliable on the desk; execCommand
        // is limited to a single copy per gesture, which is why two
        // execCommand calls copied nothing). A real gap between the two
        // writes lets the clipboard history register the id as its own
        // item before the budget overwrites the current value. The URL is
        // opened LAST (still within the gesture's activation window) so
        // focus isn't stolen before the second write.
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
        if (copyFirst) {
          await copyOne(copyFirst);
          // Give the clipboard history time to record the id as a distinct
          // entry before the budget overwrites the live clipboard.
          await new Promise((r) => setTimeout(r, 300));
        }
        await copyOne(amount);
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
