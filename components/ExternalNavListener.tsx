"use client";

import { useEffect } from "react";

/**
 * Bridge that lets nested iframes (specifically the Apps Script
 * dashboard rendered inside MetricsIframe) ask the hub's top frame
 * to navigate to an external URL.
 *
 * Why this exists: links inside the Apps Script iframe can't open
 * external destinations like ads.google.com. The iframe is sandboxed,
 * and:
 *
 *   - target="_blank" spawns a popup that inherits the sandbox flags;
 *     ads.google.com refuses to load in sandboxed browsing contexts
 *     (ERR_BLOCKED_BY_RESPONSE).
 *   - target="_top" is intercepted by Apps Script's own click handler
 *     and silently no-ops in production.
 *
 * Workaround: dashboard JS does
 *   window.top.postMessage({type:'fandf-nav-external', url}, '*')
 * on click, the hub catches it here in its non-sandboxed top frame,
 * and either window.open's a fresh tab (preferred — preserves the
 * hub) or falls back to window.location.href if popup-blocked.
 *
 * Hostname whitelist guards against any iframe (including malicious
 * cross-origin embeds, should the hub ever become embeddable) using
 * the channel as an open-redirect or arbitrary-navigation primitive.
 */
const ALLOWED_HOSTS = new Set([
  "ads.google.com",
  "adsmanager.facebook.com",
  "business.facebook.com",
  "facebook.com",
  "www.facebook.com",
  "docs.google.com",
  "sheets.google.com",
  "drive.google.com",
]);

export default function ExternalNavListener() {
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const data = e.data as { type?: unknown; url?: unknown } | null;
      if (!data || data.type !== "fandf-nav-external") return;
      if (typeof data.url !== "string") return;
      let parsed: URL;
      try {
        parsed = new URL(data.url);
      } catch {
        return;
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return;
      if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) return;
      // Try new-tab first (preserves the hub). The user-activation
      // from the originating click typically still propagates here
      // because the postMessage event is dispatched synchronously,
      // but if a popup blocker rejects window.open, fall back to
      // navigating the hub itself — the user can hit back to return.
      const popup = window.open(
        parsed.toString(),
        "_blank",
        "noopener,noreferrer",
      );
      if (!popup) {
        window.location.href = parsed.toString();
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return null;
}
