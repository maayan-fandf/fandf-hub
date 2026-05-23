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
      onClick={() => {
        // Put the slug and the budget on the clipboard as TWO SEPARATE
        // entries (not one newline-joined string), so the OS/Chrome
        // clipboard history shows each on its own — paste the campaign id
        // into the platform's campaign filter, then the daily budget into
        // the budget field. Each copy is a synchronous textarea +
        // execCommand within the click gesture (reliable + records a
        // distinct clipboard-history item per call); `amount` is written
        // last so it's the current clipboard value.
        const copyOne = (val: string): boolean => {
          try {
            const ta = document.createElement("textarea");
            ta.value = val;
            ta.style.position = "fixed";
            ta.style.top = "0";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            const ok = document.execCommand("copy");
            document.body.removeChild(ta);
            return ok;
          } catch {
            return false;
          }
        };
        let ok = true;
        if (copyFirst) ok = copyOne(copyFirst) && ok;
        ok = copyOne(amount) && ok;
        if (!ok && navigator.clipboard?.writeText) {
          // Fallback (e.g. execCommand blocked): at least the amount.
          try {
            navigator.clipboard.writeText(amount);
          } catch {
            /* best-effort */
          }
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
