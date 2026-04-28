import { auth } from "@/auth";

export default auth((req) => {
  const isLoggedIn = !!req.auth;
  const path = req.nextUrl.pathname;

  // Public paths — don't force login for these.
  const isPublic =
    path.startsWith("/api/auth") ||
    // Server-to-server endpoint called by the Apps Script poller. The
    // route enforces token-based auth itself (APPS_SCRIPT_API_TOKEN
    // shared secret), so it must skip the NextAuth redirect — Apps
    // Script triggers run unattended without a session.
    path === "/api/worktasks/auto-transition" ||
    // External-link redirect endpoint used by the dashboard's ads /
    // sheet buttons to escape Apps Script's sandboxed iframe popup
    // restrictions. The route hardcodes a hostname whitelist so it
    // can't be abused as an open redirect; making it public lets the
    // popup follow a clean top-level navigation chain to the
    // destination.
    path === "/api/external-redirect" ||
    path === "/signin" ||
    path === "/unauthorized" ||
    path === "/favicon.ico";

  // Dev convenience: if OAuth isn't configured yet, fall through and let
  // currentUserEmail()'s DEV_USER_EMAIL fallback handle identity. Once you set
  // AUTH_GOOGLE_ID, the middleware starts enforcing real sign-in.
  const oauthConfigured = !!process.env.AUTH_GOOGLE_ID;

  if (!isLoggedIn && !isPublic && oauthConfigured) {
    const url = new URL("/signin", req.nextUrl);
    url.searchParams.set("from", path);
    return Response.redirect(url);
  }
});

export const config = {
  // Skip Next.js internals + static assets so middleware doesn't run for every
  // image/bundle. The auth handler decides what's public vs protected.
  // `icon.png` is the Next.js app-router favicon convention — served as /icon.png
  // from app/icon.png; must be public so browsers can fetch it pre-login.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.png).*)"],
};
