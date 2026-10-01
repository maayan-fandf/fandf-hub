"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { CLIENT_VIEW_COOKIE, CLIENT_VIEW_MAX_AGE } from "@/lib/clientViewMode";

/**
 * 👁️ תצוגת לקוח — one switch in the top nav, for the whole hub.
 *
 * On a call with a client the owner flips between the full view and what the
 * client sees (owner request, 2026-09-29). It used to be a per-page link that
 * added `?clientView=1`, so it dropped off on the next navigation; now it is
 * a cookie (lib/clientViewMode) that every project page reads, and it stays
 * on across projects and sections until switched off.
 *
 * Internal viewers only. The project page honours the cookie for staff and
 * for the team members Keys lists under an outside address (lib/viewerTier
 * isInternalViewer); the layout, which decides who is shown the pill, has to
 * apply that same test.
 *
 * THE COOKIE IS THE TRUTH, NOT THIS COMPONENT'S STATE. The pill is the only
 * thing telling the person presenting which view the client is looking at,
 * so it must never say ON over a full report. State seeded once from the
 * server would do exactly that: the root layout does not re-render on a soft
 * navigation, so after the cookie's 12 hours lapsed — or after a flip in
 * another tab — the pill kept its old colour while the next page rendered
 * the other view. So the cookie (and a legacy `?clientView=1`, which the page
 * also honours) is re-read on every navigation and whenever the tab regains
 * focus, and a click toggles what is actually set, not what the pill showed.
 *
 * `initialOn` is the server's read of the cookie at its last render. It seeds
 * the first paint (no flip after hydration) and doubles as the check that the
 * PAGE agrees with the pill: when they differ once a transition has settled,
 * the refresh was dropped (a navigation raced it) or the state changed
 * elsewhere, and the page is refreshed — twice at most, never in a loop.
 */

const cookieOn = () =>
  document.cookie.split("; ").includes(`${CLIENT_VIEW_COOKIE}=1`);
const urlOn = () =>
  new URLSearchParams(window.location.search).get("clientView") === "1";

export default function ClientViewSwitch({ initialOn }: { initialOn: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const [on, setOn] = useState(initialOn);
  const [pending, startTransition] = useTransition();
  const retries = useRef(0);

  useEffect(() => {
    const sync = () => {
      const actual = cookieOn() || urlOn();
      setOn((prev) => {
        if (prev !== actual) retries.current = 0;
        return actual;
      });
    };
    sync();
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [pathname]);

  // The page was rendered under `initialOn`; the pill says `on`. A legacy
  // `?clientView=1` is the one legitimate difference (the page honours it
  // without any cookie), everything else means the page is stale.
  useEffect(() => {
    if (pending || on === initialOn || urlOn() || retries.current >= 2) return;
    retries.current++;
    startTransition(() => router.refresh());
  }, [pending, on, initialOn, router]);

  const flip = () => {
    if (pending) return;
    const next = !(cookieOn() || urlOn());
    document.cookie = next
      ? `${CLIENT_VIEW_COOKIE}=1; path=/; max-age=${CLIENT_VIEW_MAX_AGE}; samesite=lax`
      : `${CLIENT_VIEW_COOKIE}=; path=/; max-age=0; samesite=lax`;
    retries.current = 0;
    setOn(next);
    // An old `?clientView=1` in the address bar would keep the page in the
    // client view whatever the cookie says — drop it on the way out.
    const url = new URL(window.location.href);
    if (url.searchParams.has("clientView")) {
      url.searchParams.delete("clientView");
      router.replace(`${url.pathname}${url.search}${url.hash}`, { scroll: false });
    }
    // Server components re-render with the new cookie; client state (scroll,
    // open sections) survives.
    startTransition(() => router.refresh());
  };

  return (
    <button
      type="button"
      className={"topnav-clientview" + (on ? " is-on" : "")}
      aria-pressed={on}
      // aria-disabled, not `disabled`: a disabled button drops keyboard focus,
      // and the person toggling this back and forth on a call would have to
      // tab to it again after every press. flip() ignores a press while busy.
      aria-disabled={pending}
      onClick={flip}
      title={
        on
          ? "את/ה בתצוגת לקוח — כל פרויקט מוצג כפי שהלקוח רואה אותו. לחץ לחזרה לתצוגה המלאה."
          : "הצג את הפרויקטים כפי שהלקוח רואה אותם — נשאר פעיל במעבר בין פרויקטים, למשל בשיחת זום."
      }
    >
      <span aria-hidden>👁️</span>
      {/* Its own span so a narrow top nav can drop the words and keep the
          eye — the filled state still says it is on. */}
      <span className="topnav-clientview-label">
        {on ? "תצוגת לקוח · יציאה" : "תצוגת לקוח"}
      </span>
    </button>
  );
}
