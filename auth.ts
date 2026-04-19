import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
    }),
  ],
  pages: {
    signIn: "/signin",
  },
  // We rely on the Apps Script API to enforce access (admin or project member).
  // Any authenticated Google user can sign in; unauthorized users see the
  // "request access" screen on the home page.
  callbacks: {
    async session({ session, token }) {
      // Pass through to the session object. No customization needed — we use
      // session.user.email as the identity throughout the hub.
      return session;
    },
  },
});
