"use client";

import { useRouter } from "next/navigation";
import { SCOPE_PERSON_COOKIE } from "@/lib/scope";

type Props = {
  person: string;
};

// Rendered on project-detail pages when the URL targets a project that
// isn't in the current person-scope. We deliberately don't redirect —
// deep-links from email / chat should always resolve to their target so
// the recipient's own scope doesn't silently hijack shared links. The
// "הצג את כולם" action clears the cookie so the rest of the hub goes
// back to unscoped mode, then refreshes the current page so the banner
// disappears without a full reload.
export default function OutOfScopeBanner({ person }: Props) {
  const router = useRouter();

  function clearScope() {
    try {
      document.cookie = `${SCOPE_PERSON_COOKIE}=; path=/; max-age=0; samesite=lax`;
    } catch {
      /* private mode / cookies disabled — refresh still does the right thing */
    }
    router.refresh();
  }

  return (
    <div className="info-banner">
      ℹ️ הפרויקט הזה אינו בהיקף הנוכחי (<b>{person}</b>).{" "}
      <button
        type="button"
        onClick={clearScope}
        className="link-button"
      >
        הצג את כולם
      </button>
    </div>
  );
}
