// Server-only: imports `next/headers`, so importing this from a client
// component will fail at build time. That's the boundary we want.
import { cookies } from "next/headers";
import { SCOPE_PERSON_COOKIE } from "@/lib/scope";

/**
 * Resolve the effective person-scope for a server-side page render.
 *
 * Precedence (cookie is the source of truth, URL param is an ephemeral
 * override so shared links show the sender's scope without hijacking the
 * recipient's own):
 *
 *   1. `?person=__all__` → "" (explicit "show everything")
 *   2. `?person=<name>`  → that name (override, one request only)
 *   3. cookie value      → default scope
 *   4. no cookie         → "" (no scope)
 *
 * Callers pass the raw `searchParams.person` string so the precedence is
 * applied consistently across every page.
 *
 * Server-only by design: uses `next/headers` which can't be reached from
 * client components. The matching client-side cookie writer lives in
 * `components/HomeFilterBar.tsx` / `components/OutOfScopeBanner.tsx`.
 */
export async function getScopedPerson(paramOverride?: string): Promise<string> {
  if (paramOverride === "__all__") return "";
  if (paramOverride !== undefined && paramOverride !== "") {
    return paramOverride;
  }
  try {
    const cookieStore = await cookies();
    const raw = cookieStore.get(SCOPE_PERSON_COOKIE)?.value ?? "";
    return decodeURIComponent(raw).trim();
  } catch {
    return "";
  }
}
