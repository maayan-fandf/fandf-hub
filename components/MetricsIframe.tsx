"use client";

import { useRef, useState } from "react";

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

/**
 * Inline wrapper around the dashboard iframe, rendered inside a section
 * of the project overview page. Shows a "loading…" overlay until the
 * iframe's onLoad fires.
 */
export default function MetricsIframe({ src, projectName }: Props) {
  const [loaded, setLoaded] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

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
          onLoad={() => setLoaded(true)}
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
