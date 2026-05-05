/**
 * NextAuth type augmentation. Adds the `accessToken` field we surface on
 * `session.user` for the Drive Picker (see `auth.ts` — JWT + session
 * callbacks). Without this the Session type ships with only the default
 * `name | email | image` shape and TypeScript complains.
 */

import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: DefaultSession["user"] & {
      /** Google OAuth access_token forwarded from the JWT. Drive Picker
       *  needs this to authorize the iframe against the user's Drive.
       *  Short-lived (~1h); refreshed implicitly on next NextAuth call. */
      accessToken?: string;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    /** Google OAuth access_token captured on initial sign-in. Persisted on
     *  the encrypted NextAuth JWT cookie. */
    accessToken?: string;
  }
}
