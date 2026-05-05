import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

export const { handlers, auth, signIn, signOut } = NextAuth({
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
  // We rely on the Apps Script API to enforce access (admin or project member).
  // Any authenticated Google user can sign in; unauthorized users see the
  // "request access" screen on the home page.
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
