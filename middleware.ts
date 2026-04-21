import { auth } from "@/auth";

export default auth((req) => {
  const isLoggedIn = !!req.auth;
  const path = req.nextUrl.pathname;

  // Public paths — don't force login for these.
  const isPublic =
    path.startsWith("/api/auth") ||
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
