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
        // Mirror the dashboard's proven approach: when both a slug and a
        // budget exist, put them on ONE clipboard entry separated by a
        // newline (line 1 = slug for the campaign filter, line 2 = the
        // daily budget). Use the synchronous textarea+execCommand path
        // first (reliable inside nested iframes), clipboard API fallback.
        const value = copyFirst ? `${copyFirst}\n${amount}` : amount;
        let ok = false;
        try {
          const ta = document.createElement("textarea");
          ta.value = value;
          ta.style.position = "fixed";
          ta.style.top = "0";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          ok = document.execCommand("copy");
          document.body.removeChild(ta);
        } catch {
          /* fall through to clipboard API */
        }
        if (!ok && navigator.clipboard?.writeText) {
          try {
            navigator.clipboard.writeText(value);
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
