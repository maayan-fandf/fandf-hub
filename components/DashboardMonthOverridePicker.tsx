"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import DatePicker from "./DatePicker";

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

/** "YYYY-MM-DD" → "dd/MM" for the compact range label on the trigger. */
function ddmm(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}/${m[2]}` : iso;
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

  // Free range — clears the month override. The two single-date pickers have
  // no native min/max coupling, so guard here: if both bounds are set and
  // inverted, swap them so the applied range is always start ≤ end.
  function onRange(from: string, to: string) {
    if (from && to && from > to) {
      const t = from;
      from = to;
      to = t;
    }
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

  // Custom dropdown (a native <select> can't host the date inputs the owner
  // wants nested inside it). Close on outside-click / Esc.
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!months.length) return null;

  const triggerLabel = rangeActive
    ? `${ddmm(curFrom)}–${ddmm(curTo)}`
    : current
      ? formatMonthLabel(current)
      : "פריסה נוכחית";

  return (
    <div className="dash-month-picker" dir="rtl" ref={ref}>
      <button
        type="button"
        className={"dash-dd-trigger" + (current || rangeActive ? " is-set" : "")}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="בחר חודש או טווח תאריכים חופשי"
      >
        📅 {triggerLabel}
        <span className="dash-dd-caret" aria-hidden>▾</span>
      </button>
      {open ? (
        <div className="dash-dd-panel" role="listbox">
          {/* Month buttons scroll; the range section below stays outside the
              scroll area so the date-picker calendar popovers can overflow
              without being clipped by the panel's overflow. */}
          <div className="dash-dd-scroll">
            <button
              type="button"
              className={"dash-dd-item" + (!current && !rangeActive ? " is-sel" : "")}
              onClick={() => {
                onMonth("");
                setOpen(false);
              }}
            >
              📅 פריסה נוכחית
            </button>
            {months.map((mk) => (
              <button
                key={mk}
                type="button"
                className={"dash-dd-item" + (current === mk ? " is-sel" : "")}
                onClick={() => {
                  onMonth(mk);
                  setOpen(false);
                }}
              >
                📅 {formatMonthLabel(mk)}
              </button>
            ))}
          </div>
          {/* Nested free range — pro-rates the CRM funnel's channel cost to
              the selected days (programmatic channels use actual spend). Both
              bounds needed to take effect. Uses the same calendar DatePicker
              as the new-task page (controlled value/onChange → URL params). */}
          <div className="dash-dd-sep" />
          <div className={"dash-dd-range" + (rangeActive ? " is-active" : "")}>
            <span className="dash-dd-range-title">🗓️ טווח מותאם</span>
            <div
              className="dash-dd-range-inputs"
              title="הטווח נקרא מימין לשמאל: מימין = התחלה, משמאל = סיום"
            >
              <DatePicker
                value={curFrom}
                onChange={(iso) => onRange(iso, curTo)}
                placeholder="התחלה"
                ariaLabel="מתאריך (התחלה)"
              />
              <span className="dash-range-sep" aria-hidden>←</span>
              <DatePicker
                value={curTo}
                onChange={(iso) => onRange(curFrom, iso)}
                placeholder="סיום"
                ariaLabel="עד תאריך (סיום)"
              />
            </div>
            <span className="dash-dd-rtl-hint" aria-hidden>
              ← מימין: התחלה · משמאל: סיום
            </span>
            {current || curFrom || curTo ? (
              <button
                type="button"
                className="dash-dd-clear"
                onClick={() => {
                  clearAll();
                  setOpen(false);
                }}
              >
                ✕ נקה — חזור לפריסה נוכחית
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
