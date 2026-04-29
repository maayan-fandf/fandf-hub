"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Compact button that copies a file path to clipboard, paired with a
 * post-click instruction tooltip that walks the user through opening
 * the path in File Explorer / Finder.
 *
 * Why copy-then-paste instead of a direct "open in Explorer" link:
 * browsers block `file://` URLs from web pages for security. There's
 * no standard cross-OS way to launch a file browser from JS. Custom
 * URL protocols would work but require a per-machine install — out
 * of scope here.
 *
 * Cross-OS: callers pass Windows + macOS variants via `path` and
 * `pathMac`. Detection happens client-side via navigator.userAgent
 * (server can't know which OS the user is on). On a Mac, if `pathMac`
 * is present we use it; otherwise we fall back to `path` (callsites
 * that haven't been updated yet still work — Mac users just see the
 * Windows path with Windows instructions, same broken behavior as
 * before, no regression).
 *
 * UX flow on click:
 *   1. Path copied to clipboard.
 *   2. Button label flips to "✓ הועתק".
 *   3. A small popover appears with OS-appropriate instructions:
 *      Windows: Win+E → Ctrl+L → paste
 *      macOS:   Finder → Cmd+Shift+G → paste
 *      The full path is shown so the user can verify.
 *   4. Popover dismisses on outside-click or after ~6s.
 */
export default function CopyLocalPathButton({
  path,
  pathMac = "",
  label = "📁",
  title = "העתק נתיב לתיקייה",
}: {
  path: string;
  /** macOS variant of the path. Caller computes via
   *  buildLocalDrivePaths(...).mac. Empty string falls back to `path`
   *  for back-compat. */
  pathMac?: string;
  label?: string;
  title?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [isMac, setIsMac] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Detect macOS once on mount. navigator.platform is deprecated but
  // still reliable for Mac/Win distinction; userAgent fallback covers
  // newer browsers that have nulled it out.
  useEffect(() => {
    if (typeof navigator === "undefined") return;
    const platform = (navigator.platform || "").toLowerCase();
    const ua = (navigator.userAgent || "").toLowerCase();
    const mac = platform.includes("mac") || ua.includes("mac os");
    setIsMac(mac);
  }, []);

  // Resolved path + label set used by both the copy action and the
  // popover. When the user is on a Mac and the caller passed a
  // pathMac, we use it; otherwise fall back to the Windows path (and
  // its instructions) so older callsites still work.
  const usingMac = isMac && !!pathMac;
  const effectivePath = usingMac ? pathMac : path;

  // Auto-dismiss the hint after ~6s. Cleared if the user clicks again.
  useEffect(() => {
    if (!showHint) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setShowHint(false), 6000);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [showHint]);

  // Close on outside click + Escape.
  useEffect(() => {
    if (!showHint) return;
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setShowHint(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setShowHint(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [showHint]);

  async function copy() {
    setErr(null);
    let ok = false;
    try {
      await navigator.clipboard.writeText(effectivePath);
      ok = true;
    } catch (e) {
      // Older browsers / locked-down envs: fall back to a transient
      // textarea so at least Ctrl+C works manually if needed.
      try {
        const ta = document.createElement("textarea");
        ta.value = effectivePath;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        ok = true;
      } catch {
        setErr(e instanceof Error ? e.message : String(e));
      }
    }
    if (ok) {
      setCopied(true);
      setShowHint(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <div ref={wrapRef} className="copy-local-path-wrap">
      <button
        type="button"
        className={`btn-ghost btn-sm copy-local-path-btn${copied ? " is-copied" : ""}`}
        onClick={copy}
        title={`${title} · ${effectivePath}`}
        aria-label={title}
      >
        {copied ? "✓ הועתק" : err ? "✕" : label}
      </button>
      {showHint && (
        <div className="copy-local-path-hint" role="dialog">
          <div className="copy-local-path-hint-head">
            ✓ הנתיב הועתק לזיכרון
          </div>
          {usingMac ? (
            <ol className="copy-local-path-hint-steps">
              <li>
                פתח Finder{" "}
                <kbd>⌘</kbd>+<kbd>Tab</kbd>
              </li>
              <li>
                פתח &quot;Go to Folder&quot;{" "}
                <kbd>⌘</kbd>+<kbd>⇧</kbd>+<kbd>G</kbd>
              </li>
              <li>
                הדבק והקש{" "}
                <kbd>⌘</kbd>+<kbd>V</kbd> ואז <kbd>Return</kbd>
              </li>
            </ol>
          ) : (
            <ol className="copy-local-path-hint-steps">
              <li>
                פתח File Explorer{" "}
                <kbd>Win</kbd>+<kbd>E</kbd>
              </li>
              <li>
                לחץ על שורת הכתובת{" "}
                <kbd>Ctrl</kbd>+<kbd>L</kbd>
              </li>
              <li>
                הדבק והקש{" "}
                <kbd>Ctrl</kbd>+<kbd>V</kbd> ואז <kbd>Enter</kbd>
              </li>
            </ol>
          )}
          <code className="copy-local-path-hint-path" dir="ltr">
            {effectivePath}
          </code>
          <button
            type="button"
            className="copy-local-path-hint-close"
            onClick={() => setShowHint(false)}
            aria-label="סגור"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
