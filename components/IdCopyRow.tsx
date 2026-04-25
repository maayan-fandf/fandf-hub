"use client";

import { useState } from "react";

/**
 * Side-panel row for the task id. The id is mostly opaque to humans
 * (T-mof9z3qx-9k81-style slug) so showing it as a flat dt/dd row
 * weighted the same as company / project / kind was a UX paper-cut —
 * users glance past it 99% of the time but occasionally need to copy
 * it for a Slack ping or to reference it from another tab.
 *
 * Now: tiny monospace id + 📋 copy button. Click flips the icon to
 * ✓ for ~1.2s as confirmation, no toast infrastructure needed.
 */
export default function IdCopyRow({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Older browsers / non-secure context — fall back to a hidden
      // textarea + execCommand. Safe to silently swallow if even that
      // fails since the id is also visible inline for manual selection.
      try {
        const ta = document.createElement("textarea");
        ta.value = id;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      } catch {
        /* nothing more we can do; user can still select the visible id */
      }
    }
  }

  return (
    <div className="task-kv task-kv-id">
      <dt>id</dt>
      <dd>
        <code className="task-id-code" title={id}>
          {id}
        </code>
        <button
          type="button"
          className="task-id-copy"
          onClick={copy}
          title={copied ? "הועתק" : "העתק את ה-id"}
          aria-label={copied ? "הועתק" : "העתק את ה-id"}
        >
          {copied ? "✓" : "📋"}
        </button>
      </dd>
    </div>
  );
}
