"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  src: string;
  projectName: string;
  /**
   * Retained for source-compat with callers (page.tsx still passes it).
   * Not used by the rendered UI anymore — the wrong-account warning
   * banner was removed 2026-05-04 because the false-positive rate
   * (every slow Apps Script render triggered it) was higher than the
   * actual-helpful rate.
   */
  expectedEmail?: string;
};

/** Read the hub's currently-applied effective theme (the resolved
 *  "light"|"dark" value the layout's blocking script + ThemeToggle
 *  write to <html data-theme>). Defaults to "light" if unset. */
function readHubTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "light";
  const v = document.documentElement.getAttribute("data-theme");
  return v === "dark" ? "dark" : "light";
}

/** Append (or replace) `?theme=<value>` on the dashboard URL so the
 *  embedded dashboard reads the right theme at first parse — before
 *  its own localStorage default kicks in. */
function appendTheme(src: string, theme: "light" | "dark"): string {
  if (!src) return src;
  try {
    const u = new URL(src, "https://placeholder.invalid");
    u.searchParams.set("theme", theme);
    // Drop the placeholder origin we added — we only need it to satisfy
    // URL's parser when the src is absolute-with-protocol-relative or
    // when it's already a full URL (in which case the constructor
    // ignores the second arg). Return the absolute form.
    if (src.startsWith("/") || !/^https?:/i.test(src)) {
      // Original was relative — strip placeholder origin.
      return u.pathname + u.search + u.hash;
    }
    return u.toString();
  } catch {
    // Fallback string append. Shouldn't happen but defensive.
    const sep = src.includes("?") ? "&" : "?";
    return `${src}${sep}theme=${theme}`;
  }
}

/**
 * Inline wrapper around the dashboard iframe, rendered inside a section
 * of the project overview page. Shows a "loading…" overlay until the
 * iframe's onLoad fires.
 *
 * Theme inheritance: the dashboard runs at a different origin (Apps
 * Script's exec URL) with its own localStorage. Without help its first
 * paint always uses ITS localStorage default — typically a stale value
 * from a previous session, producing a "stuck on the wrong theme"
 * experience the user reported 2026-05-12.
 *
 * Now uses TWO mechanisms in parallel:
 *   1. URL param `?theme=light|dark` on the iframe src. The dashboard
 *      reads this at first parse (in applyThemeFromStorage) and
 *      overrides its own localStorage. No race with the message
 *      listener — the theme is applied before any default kicks in.
 *      The iframe stays at the URL-param-themed src for its lifetime;
 *      live toggles are handled via #2 without reload.
 *   2. postMessage `{type:'hub-theme', value}` for LIVE toggles — when
 *      the user toggles the hub theme without reloading, a
 *      MutationObserver on <html data-theme> forwards the change to
 *      the iframe instantly (no full reload).
 *
 * The initial iframe load is deferred until client mount so we can
 * read the hub's theme synchronously and bake it into the src — the
 * iframe makes exactly one network request. Server-side, we render
 * the loading skeleton without an iframe; that gets replaced on
 * hydrate when the theme is known.
 */
export default function MetricsIframe({ src, projectName }: Props) {
  const [loaded, setLoaded] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Themed src is null during SSR / before mount. Once we know the hub's
  // theme on the client (via useEffect), we set it once and the iframe
  // mounts with theme already in its URL.
  const [themedSrc, setThemedSrc] = useState<string | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const html = document.documentElement;
    // Bake the current hub theme into the iframe src so the dashboard's
    // first paint uses it (no race with postMessage / listener
    // registration). This runs once per `src` change.
    setThemedSrc(appendTheme(src, readHubTheme()));

    // Live-toggle forwarding — when the hub theme changes (without a
    // page reload), post the new theme to the iframe so it flips in
    // place. The dashboard's message listener handles this without
    // reloading the iframe (which would lose any in-iframe filter
    // state, scroll position, etc.).
    const send = () => {
      const win = iframeRef.current?.contentWindow;
      if (!win) return;
      try {
        win.postMessage({ type: "hub-theme", value: readHubTheme() }, "*");
      } catch {
        // Same-origin postMessage can throw in edge cases (sandbox,
        // navigation in progress). Theme drift is cosmetic — swallow.
      }
    };
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === "attributes" && m.attributeName === "data-theme") {
          send();
          return;
        }
      }
    });
    obs.observe(html, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, [src]);

  return (
    <>
      <div className="metrics-frame-wrap">
        {(!loaded || !themedSrc) && (
          <div className="metrics-loading">
            <span className="emoji" aria-hidden>📊</span>
            <span>טוען את הדוח…</span>
          </div>
        )}
        {themedSrc && (
          <iframe
            ref={iframeRef}
            src={themedSrc}
            title={`דוח שיווקי — ${projectName}`}
            className="metrics-iframe"
            onLoad={() => {
              setLoaded(true);
              // Belt-and-suspenders: even though the URL param already
              // applied the right theme at first parse, post a fresh
              // hub-theme on onLoad in case the hub theme changed
              // between the iframe's request and its response.
              try {
                iframeRef.current?.contentWindow?.postMessage(
                  { type: "hub-theme", value: readHubTheme() },
                  "*",
                );
              } catch {
                // See the MutationObserver send() for rationale.
              }
            }}
            // Eager — start the Apps Script fetch immediately on page
            // load rather than deferring to "user scrolls near". The
            // dashboard render is 5–15s on a typical project and 30s+
            // on heavy ones (e.g. אורנבך ראשון לציון: 4-channel funnel
            // pivot through Sheets); with loading="lazy" the user
            // scrolls down, sees a blank iframe, and gives up before
            // it renders. Pre-loading while the user reads the top of
            // the page (משימות / תיוגים / הערות) hides most of the
            // render cost behind their reading time. Network/CPU cost
            // is acceptable: only one iframe per project page, modern
            // browsers prioritize in-viewport requests anyway.
            loading="eager"
            // sandbox lets Apps Script JS run, talk to its own server, and
            // POST forms — same permissions as loading in a normal tab.
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
            // Cross-origin iframes need explicit allow= to use the Clipboard API.
            // Without this, navigator.clipboard.writeText() inside the dashboard
            // silently fails when it's embedded here — the pacing-cell copy-to-
            // clipboard behavior only works in a standalone tab otherwise.
            allow="clipboard-write"
          />
        )}
      </div>
    </>
  );
}
