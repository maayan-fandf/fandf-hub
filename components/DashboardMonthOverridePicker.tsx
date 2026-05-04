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

  function onChange(value: string) {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (value && /^\d{4}-\d{2}$/.test(value)) {
      params.set("monthOverride", value);
    } else {
      params.delete("monthOverride");
    }
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  if (!months.length) return null;

  return (
    <div className="dash-month-picker" dir="rtl">
      <label htmlFor="dash-month-picker-select">📊 סיכום חודשי:</label>
      <select
        id="dash-month-picker-select"
        value={current}
        onChange={(e) => onChange(e.target.value)}
        title="צפה בכל הדשבורד עבור חודש בודד"
      >
        <option value="">📊 כל התקופה</option>
        {months.map((mk) => (
          <option key={mk} value={mk}>
            📅 {formatMonthLabel(mk)}
          </option>
        ))}
      </select>
      {current ? (
        <button
          type="button"
          className="dash-month-picker-clear"
          onClick={() => onChange("")}
          title="חזור לכל התקופה"
          aria-label="חזור לכל התקופה"
        >
          ✕
        </button>
      ) : null}
    </div>
  );
}
