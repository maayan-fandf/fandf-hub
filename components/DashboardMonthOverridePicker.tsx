"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";

type Props = {
  /** Currently-applied month-override, mirrored from `?monthOverride=` in
   *  the page URL. Empty string = live mode (whole campaign period). */
  current: string;
  /** Months that have חודשי data for this user, sorted newest-first.
   *  Format: "YYYY-MM". Server-provided so we don't surface empty months. */
  months: string[];
};

const HEBREW_MONTHS = [
  "ינואר",
  "פברואר",
  "מרץ",
  "אפריל",
  "מאי",
  "יוני",
  "יולי",
  "אוגוסט",
  "ספטמבר",
  "אוקטובר",
  "נובמבר",
  "דצמבר",
];

function formatMonthLabel(monthKey: string): string {
  if (!/^\d{4}-\d{2}$/.test(monthKey)) return monthKey;
  const [y, m] = monthKey.split("-");
  return `${HEBREW_MONTHS[parseInt(m, 10) - 1]} ${y}`;
}

/**
 * Hub-side counterpart to the dashboard's in-iframe header picker. Sits next
 * to the embedded dashboard and rewinds it to a single calendar month — same
 * rewind behavior, controlled from the hub instead of from inside the
 * iframe. Wiring:
 *   1. User picks a month → router.push updates `?monthOverride=YYYY-MM`
 *   2. Page re-renders server-side; iframe `src` is rebuilt with the param
 *   3. Iframe reloads; dashboard reads `monthOverride` from its URL and
 *      seeds `MONTH_OVERRIDE` before the first `getMyProjects()` fetch
 *
 * Bookmark-friendly by design — the URL contains the full state.
 */
export default function DashboardMonthOverridePicker({ current, months }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const curFrom = searchParams?.get("from") ?? "";
  const curTo = searchParams?.get("to") ?? "";
  const rangeActive = !!(curFrom && curTo);

  function pushParams(mutate: (p: URLSearchParams) => void) {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    mutate(params);
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  // Month select — clears any free range (mutually exclusive).
  function onMonth(value: string) {
    pushParams((p) => {
      if (value && /^\d{4}-\d{2}$/.test(value)) p.set("monthOverride", value);
      else p.delete("monthOverride");
      p.delete("from");
      p.delete("to");
    });
  }

  // Free range — clears the month override.
  function onRange(from: string, to: string) {
    pushParams((p) => {
      if (from) p.set("from", from); else p.delete("from");
      if (to) p.set("to", to); else p.delete("to");
      if (from || to) p.delete("monthOverride");
    });
  }

  function clearAll() {
    pushParams((p) => {
      p.delete("monthOverride");
      p.delete("from");
      p.delete("to");
    });
  }

  if (!months.length) return null;

  return (
    <div className="dash-month-picker" dir="rtl">
      <label htmlFor="dash-month-picker-select" className="sr-only">
        סיכום חודשי
      </label>
      <select
        id="dash-month-picker-select"
        value={current}
        onChange={(e) => onMonth(e.target.value)}
        title="צפה בכל הדשבורד עבור חודש בודד"
      >
        <option value="">📅 פריסה נוכחית</option>
        {months.map((mk) => (
          <option key={mk} value={mk}>
            📅 {formatMonthLabel(mk)}
          </option>
        ))}
      </select>
      {/* Free date-range — pro-rates the CRM funnel's channel cost to the
          selected days. Both bounds needed to take effect. */}
      <span
        className={"dash-range" + (rangeActive ? " is-active" : "")}
        title="טווח תאריכים חופשי למשפך ה-CRM — העלות מחושבת יחסית לימים שנבחרו"
      >
        <input
          type="date"
          aria-label="מתאריך"
          value={curFrom}
          max={curTo || undefined}
          onChange={(e) => onRange(e.target.value, curTo)}
        />
        <span className="dash-range-sep">–</span>
        <input
          type="date"
          aria-label="עד תאריך"
          value={curTo}
          min={curFrom || undefined}
          onChange={(e) => onRange(curFrom, e.target.value)}
        />
      </span>
      {current || curFrom || curTo ? (
        <button
          type="button"
          className="dash-month-picker-clear"
          onClick={clearAll}
          title="חזור לפריסה נוכחית"
          aria-label="חזור לפריסה נוכחית"
        >
          ✕
        </button>
      ) : null}
    </div>
  );
}
