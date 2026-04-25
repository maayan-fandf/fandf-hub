"use client";

import { useState } from "react";

/**
 * Tiny 🔗 button next to the task title that copies the canonical
 * task URL to the clipboard. Closes audit #8.
 *
 * Built deliberately on browser APIs: window.location.href to read
 * the URL the user is actually on (handles ?edit=1 and any future
 * query params correctly without server-side awareness).
 *
 * Same pattern as IdCopyRow — copy → flip icon to ✓ for ~1.2s →
 * revert. No toast infrastructure needed.
 */
export default function CopyTaskLinkButton() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const url =
      typeof window !== "undefined" ? window.location.href : "";
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Older browsers / non-secure contexts. Fall back to a hidden
      // textarea + execCommand. Same fallback IdCopyRow uses.
      try {
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      } catch {
        /* user can still copy manually from the address bar */
      }
    }
  }

  return (
    <button
      type="button"
      className="task-link-copy"
      onClick={copy}
      title={copied ? "הועתק" : "העתק קישור למשימה"}
      aria-label={copied ? "הועתק" : "העתק קישור למשימה"}
    >
      {copied ? "✓" : "🔗"}
    </button>
  );
}
