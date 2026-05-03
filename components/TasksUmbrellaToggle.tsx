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
  }

  return (
    <button
      type="button"
      className={`tasks-archive-toggle${showing ? " is-showing" : " is-hiding"}`}
      onClick={toggle}
      aria-pressed={showing}
      title={
        showing
          ? "מסתיר את שורות העטיפה (ברירת מחדל)"
          : "מציג את שורות העטיפה של שרשראות"
      }
    >
      <span aria-hidden>📦</span>
      <span>עטיפות</span>
      {typeof count === "number" && count > 0 && (
        <span className="tasks-archive-toggle-count">
          {count > 99 ? "99+" : count}
        </span>
      )}
    </button>
  );
}
