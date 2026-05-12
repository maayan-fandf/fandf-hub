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

/**
 * Inline wrapper around the dashboard iframe, rendered inside a section
 * of the project overview page. Shows a "loading…" overlay until the
 * iframe's onLoad fires.
 *
 * Theme inheritance: the dashboard runs at a different origin (Apps
 * Script's exec URL) with its own localStorage, so without help it can't
 * see the hub's theme. We bridge with postMessage:
 *   - on iframe load → post current effective theme
 *   - on every hub theme toggle → post the new theme (watched via a
 *     MutationObserver on <html>'s `data-theme` attribute)
 * The dashboard listens for `{type:'hub-theme', value}` messages and
 * applies + persists the value to ITS localStorage so subsequent loads
 * paint with the right theme before the next postMessage even arrives.
 */
export default function MetricsIframe({ src, projectName }: Props) {
  const [loaded, setLoaded] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Push the hub's current theme into the iframe on every change. The
  // initial push happens in the iframe's onLoad below (so it definitely
  // fires after the iframe is ready to receive). After that, this effect
  // listens for hub-side toggles via a MutationObserver on the html
  // element and forwards each change.
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const html = document.documentElement;
    const send = () => {
      const win = iframeRef.current?.contentWindow;
      if (!win) return;
      try {
        win.postMessage({ type: "hub-theme", value: readHubTheme() }, "*");
      } catch {
        // Same-origin postMessage can throw in some edge cases (sandbox
        // restrictions, navigation in progress, etc.) — swallow and let
        // the next mutation/onLoad retry. Theme drift is cosmetic.
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
  }, []);

  return (
    <>
      <div className="metrics-frame-wrap">
        {!loaded && (
          <div className="metrics-loading">
            <span className="emoji" aria-hidden>📊</span>
            <span>טוען את הדוח…</span>
          </div>
        )}
        <iframe
          ref={iframeRef}
          src={src}
          title={`דוח שיווקי — ${projectName}`}
          className="metrics-iframe"
          onLoad={() => {
            setLoaded(true);
            // Initial theme push. Done from onLoad so we know the iframe's
            // message listener has been parsed + registered before the
            // first message lands.
            try {
              iframeRef.current?.contentWindow?.postMessage(
                { type: "hub-theme", value: readHubTheme() },
                "*",
              );
            } catch {
              // See the MutationObserver send() for rationale.
            }
          }}
          // Defer the iframe fetch until the user is close to scrolling
          // it into view. The metrics section sits below the משימות /
          // תיוגים / הערות cards, so the dashboard's Apps Script load
          // (5–15s) no longer competes for network/CPU during the page
          // render. Most users only scroll down occasionally — this
          // turns the metrics into an opt-in cost.
          loading="lazy"
          // sandbox lets Apps Script JS run, talk to its own server, and
          // POST forms — same permissions as loading in a normal tab.
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
          // Cross-origin iframes need explicit allow= to use the Clipboard API.
          // Without this, navigator.clipboard.writeText() inside the dashboard
          // silently fails when it's embedded here — the pacing-cell copy-to-
          // clipboard behavior only works in a standalone tab otherwise.
          allow="clipboard-write"
        />
      </div>
    </>
  );
}
