import { cache } from "react";
import type { Session } from "next-auth";
import { handlers, sessionOfAnyAccount, signIn, signOut } from "@/auth.base";
import { viewerTier } from "@/lib/viewerTier";

export { handlers, signIn, signOut, sessionOfAnyAccount };

/**
 * THE DOOR. The session of the signed-in viewer — or null when the Google
 * account is on no roster (not @fandf.co.il, and in no Keys row).
 *
 * Google sign-in admits anyone with a Google account, and middleware.ts runs
 * on the edge where the roster can't be read, so it can only check that
 * SOMEONE is logged in. Every route and page asks for identity through this
 * function (directly, or via currentUserEmail in lib/appsScript), so hiding a
 * stranger's session here is one choke point instead of 115 route edits: to
 * the rest of the app a stranger looks exactly like nobody — 401 from the
 * APIs, "no access" from the pages.
 *
 * It answers "may this account be in the hub at all", nothing finer. Which
 * project a client may open is lib/projectAccess; which routes are for staff
 * is lib/viewerGate.
 *
 * To address a stranger by name (/unauthorized) use sessionOfAnyAccount.
 */
export const auth = cache(async (): Promise<Session | null> => {
  const session = await sessionOfAnyAccount();
  const email = session?.user?.email;
  if (!email) return session;
  return (await viewerTier(email)) === "stranger" ? null : session;
});
