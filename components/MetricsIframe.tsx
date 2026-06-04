"use client";

import { useEffect, useRef, useState } from "react";
import LoadingVideo from "./LoadingVideo";

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

// Height bounds for the resize handle. Min keeps the iframe usable even
// after a stray drag-to-zero; max prevents the user from making it
// taller than the viewport (would push the CRM funnel below the fold).
const MIN_HEIGHT = 320;
const MAX_HEIGHT_VH = 0.92;
const HEIGHT_KEY = "hub_metrics_iframe_height";
// Default falls back to the existing CSS `min(80vh, 720px)` math. When
// the user hasn't dragged yet, we don't write any inline height so the
// stylesheet still rules — important on mobile where the breakpoint
// overrides to a shorter default.
function readSavedHeight(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(HEIGHT_KEY);
    if (!v) return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return clampHeight(n);
  } catch {
    return null;
  }
}
function clampHeight(h: number): number {
  if (typeof window === "undefined") return h;
  const max = Math.round(window.innerHeight * MAX_HEIGHT_VH);
  return Math.max(MIN_HEIGHT, Math.min(max, Math.round(h)));
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
 *
 * Vertical resize: a drag handle below the iframe lets the user grow
 * the embed to nearly the full viewport so they can work the dashboard
 * without a popout tab. Height persists in localStorage so it sticks
 * across project switches — most users either prefer "compact" or
 * "tall" and don't want to redo the drag every page. Double-click on
 * the handle resets to the CSS default (clears the override).
 */
export default function MetricsIframe({ src, projectName }: Props) {
  const [loaded, setLoaded] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Themed src is null during SSR / before mount. Once we know the hub's
  // theme on the client (via useEffect), we set it once and the iframe
  // mounts with theme already in its URL.
  const [themedSrc, setThemedSrc] = useState<string | null>(null);
  // Custom height in px. null = use stylesheet default (no inline
  // override). Hydrated from localStorage on mount.
  const [customHeight, setCustomHeight] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);
  const dragStateRef = useRef<{ startY: number; startHeight: number } | null>(
    null,
  );
  const wrapRef = useRef<HTMLDivElement | null>(null);

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

  // Iframe → hub budget-save bridge. The dashboard makes the תקציב cell
  // editable for media-role/Felix users (see Index.html); on save it
  // posts `fandf-save-budget` here with the project slug, channel name,
  // new value, and the value it saw before the edit (for drift check).
  // We POST to /api/campaigns/budget in `lookup mode` — same write path
  // the קמפיינים → תקציבים grid uses, just with the iframe relieved of
  // having to know sheet coordinates. The result is posted back so the
  // iframe can confirm or rollback the cell.
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onMessage = async (e: MessageEvent) => {
      const data = e.data;
      if (!data || data.type !== "fandf-save-budget") return;
      const win = iframeRef.current?.contentWindow;
      const reply = (payload: Record<string, unknown>) => {
        try {
          win?.postMessage({ type: "fandf-budget-saved", ...payload }, "*");
        } catch {
          /* iframe gone / navigation in progress — drop the reply */
        }
      };
      try {
        const res = await fetch("/api/campaigns/budget", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            slug: data.slug,
            channel: data.channel,
            value: data.value,
            expectedBudget: data.expectedBudget,
          }),
        });
        const json = await res.json().catch(() => ({}));
        reply({
          ok: !!json.ok,
          channel: data.channel,
          slug: data.slug,
          value: data.value,
          error: json.error || (!res.ok ? `HTTP ${res.status}` : ""),
        });
      } catch (err) {
        reply({
          ok: false,
          channel: data.channel,
          slug: data.slug,
          value: data.value,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Hydrate persisted height on mount — separate from the theme effect
  // so it runs exactly once and doesn't re-clamp on every src change.
  useEffect(() => {
    const saved = readSavedHeight();
    if (saved != null) setCustomHeight(saved);
  }, []);

  // Pointer-based drag — single source of truth for resize. Uses Pointer
  // Events so the same code path covers mouse, touch, and pen without
  // separate listeners. `setPointerCapture` is critical because the
  // iframe will capture pointermove events the moment the pointer
  // crosses into it — capturing on the handle keeps the parent
  // receiving moves throughout the drag.
  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const wrapEl = wrapRef.current;
    if (!wrapEl) return;
    const currentHeight = wrapEl.getBoundingClientRect().height;
    dragStateRef.current = { startY: e.clientY, startHeight: currentHeight };
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    setResizing(true);
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const st = dragStateRef.current;
    if (!st) return;
    const dy = e.clientY - st.startY;
    setCustomHeight(clampHeight(st.startHeight + dy));
  }
  function onPointerEnd(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragStateRef.current) return;
    dragStateRef.current = null;
    setResizing(false);
    try {
      (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
    } catch {
      // Capture may have already been released by the browser if the
      // pointer was lost — non-fatal.
    }
    // Persist final height. Reading from the latest state via the
    // wrapper ref keeps the saved value consistent even if React
    // batched the last setCustomHeight call.
    const wrapEl = wrapRef.current;
    if (wrapEl) {
      try {
        const h = Math.round(wrapEl.getBoundingClientRect().height);
        window.localStorage.setItem(HEIGHT_KEY, String(h));
      } catch {
        // Private mode / quota — height persisted in-memory for the
        // session is still fine.
      }
    }
  }

  // Double-click resets to stylesheet default and clears the saved
  // override. Useful escape hatch if the user got the size wrong on
  // a small viewport.
  function onHandleDoubleClick() {
    setCustomHeight(null);
    try {
      window.localStorage.removeItem(HEIGHT_KEY);
    } catch {
      /* ignore */
    }
  }

  // When the user is mid-drag, an invisible shield over the iframe
  // catches the pointer events that would otherwise be eaten by the
  // cross-origin iframe — without it, the drag stalls the moment the
  // pointer crosses into the iframe area.
  return (
    <>
      <div
        ref={wrapRef}
        className="metrics-frame-wrap"
        style={
          customHeight != null
            ? { height: `${customHeight}px`, minHeight: `${customHeight}px` }
            : undefined
        }
      >
        {(!loaded || !themedSrc) && (
          <div className="metrics-loading">
            {/* Same animation as every other loading boundary on the hub
                (app/.../loading.tsx). Compact + circular crop so it sits
                inside the iframe overlay without dominating it. */}
            <LoadingVideo compact label="טוען את הדוח…" />
          </div>
        )}
        {themedSrc && (
          <iframe
            ref={iframeRef}
            src={themedSrc}
            title={`דוח שיווקי — ${projectName}`}
            className="metrics-iframe"
            style={
              customHeight != null ? { height: `${customHeight}px` } : undefined
            }
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
        {/* Pointer shield: covers the iframe during drag so pointermove
            events keep firing on the parent. Pointer-events:none normally
            (so the iframe stays interactive), flipped on only while
            resizing. */}
        <div
          className="metrics-frame-shield"
          aria-hidden
          data-active={resizing ? "1" : "0"}
        />
      </div>
      {/* Drag handle: stripe under the iframe. Double-click resets to
          the CSS default height. */}
      <div
        className="metrics-frame-resize-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label="גרור כדי לשנות את גובה הדשבורד; לחיצה כפולה לגובה ברירת המחדל"
        title="גרור כדי לשנות גובה • לחיצה כפולה — איפוס"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onDoubleClick={onHandleDoubleClick}
        data-active={resizing ? "1" : "0"}
      >
        <span className="metrics-frame-resize-grip" aria-hidden />
      </div>
    </>
  );
}
