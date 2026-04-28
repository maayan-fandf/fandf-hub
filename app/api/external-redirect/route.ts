import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/external-redirect?url=<encoded>
 *
 * Server-side 302 to a whitelisted destination. Used by the legacy
 * dashboard's "🔍 Google Ads" / "📘 Facebook Ads" buttons (and the
 * per-channel pacing-cell links) to escape Apps Script's sandboxed
 * iframe — clicking `target="_blank"` from inside the sandbox spawns
 * a popup that inherits the iframe's sandbox restrictions, and
 * Google Ads' COOP / X-Frame-Options checks reject the inherited
 * "null origin". By routing the click through hub.fandf.co.il first,
 * the popup starts on a clean, non-sandboxed top-level context — the
 * subsequent 302 to ads.google.com is then a normal navigation and
 * loads cleanly.
 *
 * Hostname whitelist guards against open-redirect abuse. Anything not
 * on the list returns 400 — never bounce an arbitrary URL.
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

export async function GET(req: Request) {
  const url = new URL(req.url);
  const target = url.searchParams.get("url");
  if (!target) {
    return NextResponse.json(
      { ok: false, error: "url query parameter required" },
      { status: 400 },
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return NextResponse.json(
      { ok: false, error: "url must be a valid absolute URL" },
      { status: 400 },
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return NextResponse.json(
      { ok: false, error: "only http(s) URLs are allowed" },
      { status: 400 },
    );
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
    return NextResponse.json(
      {
        ok: false,
        error: `Destination hostname not allowed: ${parsed.hostname}`,
      },
      { status: 400 },
    );
  }
  // 302 so the browser follows immediately. Cache-Control: no-store so
  // intermediate proxies don't cache the redirect — the URL parameter
  // can vary per click and we don't want to serve a stale destination.
  return NextResponse.redirect(parsed.toString(), {
    status: 302,
    headers: { "cache-control": "no-store" },
  });
}
