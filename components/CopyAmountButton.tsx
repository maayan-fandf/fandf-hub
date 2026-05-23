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
        try {
          if (navigator.clipboard?.writeText) {
            // Sequential awaited writes so BOTH land in clipboard history
            // (Win+V / Chrome clipboard), with `amount` as the current
            // clipboard value.
            if (copyFirst) await navigator.clipboard.writeText(copyFirst);
            await navigator.clipboard.writeText(amount);
          } else {
            const ta = document.createElement("textarea");
            ta.value = amount;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
          }
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          /* best-effort — still open the URL below */
        }
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
