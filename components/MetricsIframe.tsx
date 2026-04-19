"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  src: string;
  projectName: string;
};

/**
 * Inline wrapper around the dashboard iframe, rendered inside a section
 * of the project overview page. Responsibilities:
 *   - Show a "loading…" overlay until onLoad fires
 *   - After 6s with no load event, surface a fallback hint with an
 *     open-in-new-tab button (third-party cookies, Apps Script sign-in
 *     loop, or X-Frame block all silently fail the same way)
 *
 * We deliberately don't cross-origin-probe to detect auth failures —
 * not possible in browsers, and not worth the code. The 6-second
 * heuristic + always-available fallback is simpler and sufficient.
 */
export default function MetricsIframe({ src, projectName }: Props) {
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
        />
      </div>

      {slowWarning && (
        <div className="metrics-slow-warning">
          <span className="emoji" aria-hidden>⚠️</span>
          <div>
            <div><b>לא נטען תוך כמה שניות?</b></div>
            <div className="subtitle">
              חלק מהדפדפנים חוסמים עוגיות-צד-שלישי, מה שמונע כניסה ל-Google בתוך
              מסגרת. אם הדוח נשאר ריק —{" "}
              <a href={src} target="_blank" rel="noreferrer">
                פתח בכרטיסייה חדשה ↗
              </a>
              .
            </div>
          </div>
        </div>
      )}
    </>
  );
}
