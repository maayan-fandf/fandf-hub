"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  src: string;
  projectName: string;
};

/**
 * Wrapper around the dashboard iframe that:
 *   - Shows a "loading..." overlay until onLoad fires
 *   - ALWAYS shows a prominent "פתח בכרטיסייה חדשה" button — this is the
 *     deterministic fallback when the iframe silently fails (third-party
 *     cookies, Apps Script sign-in loop, X-Frame blocks)
 *   - After a 6-second timeout with no load event, surfaces a hint that
 *     things may not have loaded and nudges toward the new-tab button
 *
 * We intentionally don't try to peek into the iframe's content (can't —
 * cross-origin) or infer "did auth work?" from onLoad (it fires on any
 * navigation in the iframe, including redirects to sign-in).
 */
export default function MetricsIframe({ src, projectName }: Props) {
  const [loaded, setLoaded] = useState(false);
  const [slowWarning, setSlowWarning] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    // If onLoad hasn't fired within 6s, show a nudge toward the fallback.
    const t = window.setTimeout(() => {
      if (!loaded) setSlowWarning(true);
    }, 6000);
    return () => window.clearTimeout(t);
  }, [loaded]);

  return (
    <div className="metrics-wrap">
      <div className="metrics-foot-top">
        <div className="subtitle">
          הדוח נטען מהדשבורד המקורי, מסונן לפרויקט <b>{projectName}</b>.
        </div>
        <a
          className="reply-btn reply-btn-primary"
          href={src}
          target="_blank"
          rel="noreferrer"
        >
          פתח בכרטיסייה חדשה ↗
        </a>
      </div>

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
          // We don't set allow-top-navigation (iframe shouldn't take over).
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
              מסגרת. אם אתה רואה מסך ריק — לחץ על הכפתור למעלה ופתח בכרטיסייה
              חדשה.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
