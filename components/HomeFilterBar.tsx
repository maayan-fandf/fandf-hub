"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";

type Props = {
  people: string[];
  selected: string;    // "" means "show all"
  currentUser: string; // may be empty for clients / admins without a resolvable person
  totalCount: number;
  mineCount: number;
};

const HIDE_ENDED_KEY = "hub_hide_ended";
const SCOPE_COOKIE = "hub_scope_person";

/**
 * Persist the person scope in a cookie so the top-nav projects dropdown
 * (a server component in app/layout.tsx) can read the same filter and
 * narrow its list accordingly. Cookie is the single source of truth for
 * "what person am I scoped to across the whole hub".
 *
 *   person = ""   → clear cookie (= "show everything")
 *   person = "X"  → cookie = X (URI-encoded so Hebrew names survive)
 */
function writeScopeCookie(person: string) {
  try {
    if (person) {
      const value = encodeURIComponent(person);
      // 1 year, site-wide, lax so it's sent on normal navigations.
      document.cookie = `${SCOPE_COOKIE}=${value}; path=/; max-age=31536000; samesite=lax`;
    } else {
      document.cookie = `${SCOPE_COOKIE}=; path=/; max-age=0; samesite=lax`;
    }
  } catch {
    /* private mode / cookies disabled — scope falls back to URL param only */
  }
}

// Combined filter bar for the home page: person dropdown + hide-ended toggle.
// Mirrors the dashboard conventions — person defaults to the current user;
// hide-ended defaults to ON and persists in localStorage. Both filters run on
// the CLIENT: person via URL param (SSR-friendly), hide-ended via a data-
// attribute on <html> that CSS uses to hide rows marked data-ended="1".
export default function HomeFilterBar({
  people,
  selected,
  currentUser,
  totalCount,
  mineCount,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  // hide-ended: default ON; explicit opt-out via localStorage="0". Matches the
  // dashboard exactly so the UX transfers. `mounted` gates the first DOM write
  // to avoid hydration mismatch on the <html> data-attribute.
  const [hideEnded, setHideEnded] = useState(true);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    try {
      const v = localStorage.getItem(HIDE_ENDED_KEY);
      if (v === "0") setHideEnded(false);
    } catch {
      /* private mode — keep default */
    }
  }, []);
  useEffect(() => {
    if (!mounted) return;
    document.documentElement.dataset.hideEnded = hideEnded ? "1" : "0";
    try {
      localStorage.setItem(HIDE_ENDED_KEY, hideEnded ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [hideEnded, mounted]);
  // Apply the default data-attribute immediately on first mount, even if the
  // stored value matches the default — so CSS takes effect on first hydration.
  const appliedInit = useRef(false);
  useEffect(() => {
    if (!mounted || appliedInit.current) return;
    appliedInit.current = true;
    document.documentElement.dataset.hideEnded = hideEnded ? "1" : "0";
  }, [mounted, hideEnded]);

  function onPersonChange(value: string) {
    const params = new URLSearchParams(sp.toString());
    if (value === "") {
      params.set("person", "__all__");
    } else if (currentUser && value === currentUser) {
      // Default: current user — clear the param so the URL stays clean.
      params.delete("person");
    } else {
      params.set("person", value);
    }
    // Mirror the selection into the scope cookie so the top-nav projects
    // dropdown (server component) reflects the same filter. "Show all" wipes
    // the cookie; any specific person name (including the current user) sets
    // it, so the nav stays scoped even after the URL param is cleared.
    writeScopeCookie(value);
    const qs = params.toString();
    router.push(pathname + (qs ? "?" + qs : ""));
  }

  // Seed the scope cookie on first mount so users who loaded the page with a
  // server-rendered default (URL param absent → server picks currentUser) also
  // get the nav scoped. Without this, the nav shows all projects until the
  // first dropdown interaction. Only writes when `selected` has a value; no-op
  // on "show all" since that's already an empty/missing cookie.
  useEffect(() => {
    if (selected) writeScopeCookie(selected);
  }, [selected]);

  // De-dupe + sort the people list with current user first.
  const otherPeople = people
    .filter((n) => n && (!currentUser || n !== currentUser))
    .sort((a, b) => a.localeCompare(b, "he"));

  // Derive the <select> value from `selected`. "" => "__all__" sentinel.
  const selectValue = selected === "" ? "__all__" : selected;

  return (
    <div className="home-filter-bar">
      <div className="home-filter-pill home-filter-pill--select">
        <span className="home-filter-pill-icon" aria-hidden>
          👤
        </span>
        <select
          className="home-filter-select"
          aria-label="סנן לפי אדם"
          value={selectValue}
          onChange={(e) =>
            onPersonChange(e.target.value === "__all__" ? "" : e.target.value)
          }
        >
          <option value="__all__">הצג הכל ({totalCount})</option>
          {currentUser && (
            <option value={currentUser}>
              שלי — {currentUser} ({mineCount})
            </option>
          )}
          {otherPeople.length > 0 && (
            <optgroup label="אנשים נוספים">
              {otherPeople.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </div>

      <button
        type="button"
        className={`home-filter-pill home-filter-pill--button${hideEnded ? " is-active" : ""}`}
        onClick={() => setHideEnded((v) => !v)}
        title={
          hideEnded
            ? "מציג רק פרויקטים פעילים (הסתיימו לפני יותר מ-5 ימים מוסתרים)"
            : "הסתר פרויקטים שתאריך הסיום שלהם עבר לפני יותר מ-5 ימים"
        }
      >
        <span className="home-filter-pill-icon" aria-hidden>
          🕑
        </span>
        <span>{hideEnded ? "הצג שהסתיימו" : "הסתר שהסתיימו"}</span>
      </button>
    </div>
  );
}
