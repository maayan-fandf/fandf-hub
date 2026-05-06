"use client";

import Link from "next/link";

type Props = {
  /** True when the queue is showing the role-default "relevant to me"
   *  scope. False when the user has opted into "show everything"
   *  (?mine=0). */
  mineOptIn: boolean;
  /** Pre-built href that flips to "show all" — preserves every other
   *  filter / view / sort param. Built by the parent so the URL math
   *  stays in one place. */
  showAllHref: string;
  /** Pre-built href that flips back to the role default. */
  defaultHref: string;
  /** Optional text for the active state's label. Defaults to a
   *  generic "רק שלי" but the parent can substitute a role-aware
   *  variant ("רק שיוצרתי", "רק שאני מבצע", etc.). */
  myLabel?: string;
};

/**
 * Header-row toggle controlling the queue's identity scope: "my
 * stuff only" (the role-aware default — author/approver/assignee
 * filter applied) vs "everyone's stuff" (?mine=0, the unscoped
 * portfolio view).
 *
 * Same segmented-control chrome as TasksViewToggle so the toggle
 * group reads as a coherent control row above the table. Single
 * pill with two labels so the user always sees both states (active
 * + the alternative); click flips between them.
 *
 * Reported by Maayan: "i think there is a better place for this
 * toggle, maybe somewhere along the top toggles row where kanban
 * etc are". Replaces the previous "הצג את כולם" link buried in the
 * subtitle copy.
 */
export default function TasksScopeToggle({
  mineOptIn,
  showAllHref,
  defaultHref,
  myLabel = "רק שלי",
}: Props) {
  return (
    <div
      className="tasks-scope-toggle"
      role="tablist"
      aria-label="היקף הרשימה"
    >
      <Link
        href={defaultHref}
        scroll={false}
        className={`tasks-scope-toggle-btn${mineOptIn ? " is-active" : ""}`}
        aria-current={mineOptIn ? "page" : undefined}
        role="tab"
        aria-selected={mineOptIn}
        title="הראה רק את המשימות שאני מעורב/ת בהן (יוצר/ת, מאשר/ת, מבצע/ת או מתויג/ת בדיון)"
      >
        <span aria-hidden>🎯</span>
        {myLabel}
      </Link>
      <Link
        href={showAllHref}
        scroll={false}
        className={`tasks-scope-toggle-btn${!mineOptIn ? " is-active" : ""}`}
        aria-current={!mineOptIn ? "page" : undefined}
        role="tab"
        aria-selected={!mineOptIn}
        title="הראה את כל המשימות במערכת (לא מסונן לפי אדם)"
      >
        <span aria-hidden>🌐</span>
        הכל
      </Link>
    </div>
  );
}
