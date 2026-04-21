"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  src: string;
  projectName: string;
  /**
   * Email the hub's session says you are. Used in the fallback message
   * ("make sure you're signed into Google as X") and to pre-fill the
   * Google AccountChooser link when the iframe can't load.
   */
  expectedEmail?: string;
};

/**
 * Inline wrapper around the dashboard iframe, rendered inside a section
 * of the project overview page. Responsibilities:
 *   - Show a "loading…" overlay until onLoad fires
 *   - After 6s with no load event, surface a fallback hint with an
 *     open-in-new-tab button AND a Google AccountChooser link pre-filled
 *     with the user's hub-session email (helps when the browser is
 *     signed into the wrong Google account — the #1 cause of iframe
 *     auth failures)
 *
 * We deliberately don't cross-origin-probe to detect auth failures —
 * not possible in browsers, and not worth the code. The 6-second
 * heuristic + always-available fallback is simpler and sufficient.
 */
export default function MetricsIframe({ src, projectName, expectedEmail }: Props) {
  const [loaded, setLoaded] = useState(false);
  const [slowWarning, setSlowWarning] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => {
      if (!loaded) setSlowWarning(true);
    }, 6000);
    return () => window.clearTimeout(t);
  }, [loaded]);

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

      {slowWarning && (
        <div className="metrics-slow-warning">
          <span className="emoji" aria-hidden>⚠️</span>
          <div>
            <div><b>לא נטען? רוב הסיכויים שהדפדפן מחובר ל-Google עם חשבון אחר.</b></div>
            <div className="subtitle">
              {expectedEmail && (
                <>
                  ודאו שאתם מחוברים ל-Google עם החשבון{" "}
                  <code dir="ltr">{expectedEmail}</code>.{" "}
                </>
              )}
              אם לא —{" "}
              {expectedEmail ? (
                <a
                  href={`https://accounts.google.com/AccountChooser?Email=${encodeURIComponent(
                    expectedEmail,
                  )}&continue=${encodeURIComponent(src)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  התחבר לחשבון הנכון ↗
                </a>
              ) : (
                <a href={src} target="_blank" rel="noreferrer">
                  פתח בכרטיסייה חדשה ↗
                </a>
              )}
              {expectedEmail && (
                <>
                  {" "}או{" "}
                  <a href={src} target="_blank" rel="noreferrer">
                    פתח בכרטיסייה חדשה ↗
                  </a>
                </>
              )}
              .
            </div>
          </div>
        </div>
      )}
    </>
  );
}
