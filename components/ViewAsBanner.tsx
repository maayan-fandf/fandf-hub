"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Single coupled client component for the view-as session model:
 *
 *   - On mount: reads the `hub_view_as` cookie + the server-rendered
 *     `serverViewAs` prop (the cookie value the layout already
 *     resolved + admin-gated). Renders a sticky banner under the
 *     topnav whenever view-as is active so the user can't miss that
 *     they're peeking.
 *
 *   - beforeunload: clears the cookie before the next request fires.
 *     Hard refresh + tab close therefore both reset to the actual
 *     user. Client-side Next.js navigation does NOT trigger
 *     beforeunload, so view-as survives within-app navigation.
 *
 *   - Exit button: clears the cookie AND POSTs `view_as_email: ""`
 *     to /api/me/prefs so any legacy sheet value (pre-2026-04-30
 *     gear-menu writes) is also cleaned out. Then reloads to
 *     re-render server pages.
 */
export default function ViewAsBanner({
  serverViewAs,
  myEmail,
}: {
  serverViewAs: string;
  myEmail: string;
}) {
  const router = useRouter();
  const [active, setActive] = useState<string>(serverViewAs);

  useEffect(() => {
    const onBeforeUnload = () => {
      // Clear cookie immediately so the next request (refresh / new
      // tab navigation) doesn't carry it.
      document.cookie = `hub_view_as=; path=/; max-age=0; SameSite=Lax`;
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // Reflect the server-rendered value when navigation lands a fresh
  // render (Next 15 re-runs the layout's data fetch on each navigation).
  useEffect(() => {
    setActive(serverViewAs);
  }, [serverViewAs]);

  if (!active || active.toLowerCase() === myEmail.toLowerCase()) {
    return null;
  }

  function exit() {
    document.cookie = `hub_view_as=; path=/; max-age=0; SameSite=Lax`;
    setActive("");
    // Belt-and-suspenders: if a legacy `view_as_email` is still on the
    // user's prefs row (gear-menu writes pre-2026-04-30 used to populate
    // it), wipe it too. `keepalive: true` lets the request survive the
    // reload below; we don't await — a slow round-trip shouldn't block
    // the user from getting their own pages back.
    void fetch("/api/me/prefs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ view_as_email: "" }),
      keepalive: true,
    }).catch(() => {});
    // Hard reload to re-render server pages without the cookie. router.refresh()
    // alone doesn't always re-derive layout-level data fetches.
    window.location.reload();
  }

  return (
    <div className="view-as-banner" role="status" aria-live="polite">
      <span className="view-as-banner-icon" aria-hidden>👁️</span>
      <span className="view-as-banner-text">
        מציג כ-<span dir="ltr">{active}</span>
      </span>
      <button
        type="button"
        className="view-as-banner-exit"
        onClick={exit}
      >
        חזור להציג את עצמי
      </button>
    </div>
  );
}
