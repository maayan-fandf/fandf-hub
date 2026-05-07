"use server";

import { signOut } from "@/auth";

/**
 * Server action exposed to client components for signing the user out.
 * Used by TopnavUserMenu (the user-pill dropdown in the topnav). The
 * inline `<form action={async () => { "use server"; ... }}>` pattern
 * worked when signOut sat in the layout itself, but a client-component
 * trigger needs an importable action — that's this.
 */
export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/signin" });
}
