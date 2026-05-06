"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";

type Props = {
  /** Whether umbrellas are currently surfaced on the page (mirrors
   *  ?umbrellas=1). The chip flips this in the URL — no user pref
   *  is persisted (this is a per-session preference, not a global
   *  one like hide_archived). */
  showing: boolean;
  /** Optional count of umbrella rows in the current dataset — when
   *  > 0 we render a small badge so users know how many they'd
   *  surface by clicking. Defer wiring this; v1 ships without the
   *  count. */
  count?: number;
};

/**
 * Header chip on /tasks that toggles `?umbrellas=1`. Default state
 * (URL has no `umbrellas` param) hides umbrella container rows; the
 * chip flips on showing them. Phase 4 of dependencies feature,
 * 2026-05-03.
 *
 * Why URL-state instead of a user pref: umbrellas are a chain-
 * specific concern, and most users will only need to surface them
 * occasionally (auditing the chain pipeline). Persisting it as a
 * pref would surface umbrellas every time the user re-opens /tasks,
 * which is the opposite of the right default.
 */
export default function TasksUmbrellaToggle({ showing, count }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function toggle() {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (showing) params.delete("umbrellas");
    else params.set("umbrellas", "1");
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
    // Next.js 15 App Router holds a client-side route cache; pushing
    // to /tasks?umbrellas=1 from /tasks (or back) was returning the
    // pre-toggle render without re-hitting the server, so the user saw
    // identical row counts. Force a refetch — the page is force-dynamic
    // server-side anyway, this just bypasses the route segment cache.
    router.refresh();
  }

  // Long-form explanation — same text both states (so hovering before
  // and after a click shows a consistent picture of what the toggle
  // governs), with the action prefix swapping based on current state.
  // Native title tooltips wrap on most browsers; line breaks help.
  const concept =
    "כל שרשרת (סדר מסירה) או מטריה מקבילה (משימה לכל אדם תחת אותה משימת-על) " +
    "נשמרת תחת שורת 'עטיפה' שמרכזת את הסטטוס של תתי-המשימות. " +
    "ברירת המחדל מסתירה את שורות העטיפה כדי להציג רק עבודה קונקרטית.";
  const action = showing
    ? "לחץ כדי להסתיר את שורות העטיפה (חזרה לברירת המחדל)."
    : "לחץ כדי להציג גם את שורות העטיפה (שימושי לסקירת כל השרשראות והמטריות במבט-על).";
  return (
    <button
      type="button"
      className={`tasks-archive-toggle${showing ? " is-showing" : " is-hiding"}`}
      onClick={toggle}
      aria-pressed={showing}
      title={`${concept}\n\n${action}`}
    >
      <span aria-hidden>🪆</span>
      <span>עטיפות</span>
      {typeof count === "number" && count > 0 && (
        <span className="tasks-archive-toggle-count">
          {count > 99 ? "99+" : count}
        </span>
      )}
    </button>
  );
}
