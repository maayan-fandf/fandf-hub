"use client";

import { useState } from "react";

/**
 * Compact icon button next to the "Drive" link. When Google Drive for
 * Desktop is installed, the user has the same folder synced locally —
 * we can't open the file browser programmatically (browsers block
 * file:// from web pages for security), but we can copy the path the
 * user pastes into File Explorer / Finder.
 *
 * The path is in-Drive (`Shared drives/<name>/<company>/<project>`).
 * The mount point varies — Windows: `G:\`; Mac: `/Volumes/GoogleDrive/` —
 * so the user pastes the suffix relative to their own Drive root.
 */
export default function CopyLocalPathButton({
  path,
  label = "📂",
  title = "העתק נתיב מקומי (Drive Desktop)",
}: {
  path: string;
  label?: string;
  title?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function copy() {
    setErr(null);
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      // Older browsers / locked-down envs: fall back to a transient
      // textarea so at least Ctrl+C works manually if needed.
      try {
        const ta = document.createElement("textarea");
        ta.value = path;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      } catch {
        setErr(e instanceof Error ? e.message : String(e));
      }
    }
  }

  return (
    <button
      type="button"
      className={`btn-ghost btn-sm copy-local-path-btn${copied ? " is-copied" : ""}`}
      onClick={copy}
      title={`${title}\n${path}`}
      aria-label={title}
    >
      {copied ? "✓ הועתק" : err ? "✕" : label}
    </button>
  );
}
