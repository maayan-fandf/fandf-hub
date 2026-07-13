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
    // Cloud Scheduler cron entry point (replaces the Apps Script
    // pollTaskCompletions trigger). Same shared-secret auth model as
    // the auto-transition endpoint above.
    path === "/api/cron/poll-tasks" ||
    // Server-to-server alert-dismissals store, called by the Apps Script
    // report (token-authed via APPS_SCRIPT_API_TOKEN). Must skip the
    // NextAuth redirect — Apps Script runs unattended.
    path === "/api/alert-dismissals" ||
    // Server-to-server CRM-funnel read, called by the Apps Script report
    // to replace its pro-rated free-range funnel with actual windowed
    // counts (token-authed via APPS_SCRIPT_API_TOKEN). Unattended — skip
    // the NextAuth redirect.
    path === "/api/crm-funnel" ||
    // Server-to-server live per-project FB creative/audience/keyword meetings,
    // called by the Apps Script report to replace the stale-prone Sheet export
    // (token-authed via APPS_SCRIPT_API_TOKEN). Unattended — skip NextAuth.
    path === "/api/fb-creative-meetings" ||
    // Instant-budget-sync cache-bust webhook, pinged by the Apps Script onEdit
    // trigger the moment the main sheet is edited (token-authed via
    // APPS_SCRIPT_API_TOKEN). Unattended — must skip the NextAuth redirect.
    path === "/api/revalidate-budgets" ||
    // Cloud Scheduler membership-reconcile cron. Same shared-secret
    // (X-Cron-Token / APPS_SCRIPT_API_TOKEN) auth as poll-tasks; must
    // skip the NextAuth redirect or Scheduler gets a 302→/signin
    // (surfaces as a 400 INVALID_ARGUMENT on the job).
    path === "/api/cron/sync-chat-spaces" ||
    // Cloud Scheduler cron — recomputes per-creative/audience CRM meetings
    // into the creative Sheet for the report. Same X-Cron-Token shared secret;
    // server-to-server, must skip the NextAuth redirect.
    path === "/api/cron/fb-creative-meetings" ||
    // One-off batch space re-provisioner (delete+recreate-as-threaded
    // migration). Same X-Cron-Token shared secret; server-to-server,
    // must skip the NextAuth redirect.
    path === "/api/admin/recreate-chat-spaces" ||
    // External-link redirect endpoint used by the dashboard's ads /
    // sheet buttons to escape Apps Script's sandboxed iframe popup
    // restrictions. The route hardcodes a hostname whitelist so it
    // can't be abused as an open redirect; making it public lets the
    // popup follow a clean top-level navigation chain to the
    // destination.
    path === "/api/external-redirect" ||
    // Public Tampermonkey userscripts — must be reachable without a
    // session so the extension can auto-update them. The files live
    // in public/userscripts/ and are intentionally non-sensitive (they
    // contain glue logic that runs against ads.google.com; no F&F
    // tokens or business data). Without this exemption Tampermonkey's
    // auto-update request gets a 302→/signin and silently fails.
    path.startsWith("/userscripts/") ||
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
