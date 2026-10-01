import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

/**
 * The NextAuth instance itself — EDGE-SAFE, and it must stay that way:
 * middleware.ts imports this file and runs on the edge runtime, where
 * googleapis cannot load. So nothing here may import the Keys roster.
 *
 * `sessionOfAnyAccount` is the raw NextAuth session: it answers for EVERY
 * Google account that signed in, including one that is on no roster at all.
 * It is not what the app should ask. Routes and pages import `auth` from
 * "@/auth", which hides accounts that are not on the roster; only the
 * middleware (which can't read Keys) and the two places that must address a
 * stranger by name (/unauthorized, the home redirect) use this one.
 */
export const {
  handlers,
  auth: sessionOfAnyAccount,
  signIn,
  signOut,
} = NextAuth({
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
      // `drive.file` is the narrowest Drive scope that supports the Drive
      // Picker API end-to-end: per-file access to anything the user picks
      // through the Picker dialog OR uploads via the app. Crucially it's
      // NOT a "restricted" scope under Google's verification rules — using
      // `drive.readonly` or full `drive` would force the app through the
      // restricted-scope verification (with an annual security audit).
      // Added 2026-05-05 alongside the Drive Picker test-drive on the
      // new-task page (components/DrivePickerButton.tsx).
      authorization: {
        params: {
          scope:
            "openid email profile https://www.googleapis.com/auth/drive.file",
        },
      },
    }),
  ],
  pages: {
    signIn: "/signin",
  },
  // Any Google account can complete sign-in — the roster lives in a Sheet the
  // edge runtime can't read, so it is not checked here. The door is one step
  // later: `auth` in "@/auth" returns no session for an account that is on
  // no roster, which is what every route and page actually calls.
  callbacks: {
    // The JWT callback fires on initial sign-in (with `account` populated)
    // and on every subsequent token refresh (with `account` undefined). We
    // capture Google's `access_token` on first sign-in and persist it on the
    // NextAuth JWT so the session callback can hand it to the client. The
    // token is short-lived (~1h) — when it expires the user re-authenticates
    // implicitly via NextAuth, which re-issues the JWT with a fresh token.
    async jwt({ token, account }) {
      if (account?.access_token) {
        token.accessToken = account.access_token;
      }
      return token;
    },
    async session({ session, token }) {
      // Surface the Google access token on session.user so client
      // components (DrivePickerButton) can pass it to the Picker SDK.
      // Email stays the canonical identity throughout the rest of the hub.
      if (session.user && typeof token.accessToken === "string") {
        session.user.accessToken = token.accessToken;
      }
      return session;
    },
  },
});
