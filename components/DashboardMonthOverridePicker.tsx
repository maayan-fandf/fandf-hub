"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import DateRangePicker from "./DateRangePicker";

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

  // Re-rendering the project page server-side (sheet reads + iframe rebuild)
  // takes several seconds, so wrap every navigation in a transition. `isPending`
  // drives the "מעדכן…" cue on the trigger so the choice clearly registered and
  // the user knows the page is reloading with the new period. `pendingLabel`
  // shows the just-picked period immediately (the URL — and thus the derived
  // label below — only updates once the transition resolves).
  const [isPending, startTransition] = useTransition();
  const [pendingLabel, setPendingLabel] = useState<string | null>(null);
  useEffect(() => {
    if (!isPending) setPendingLabel(null);
  }, [isPending]);

  function pushParams(mutate: (p: URLSearchParams) => void, label: string) {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    mutate(params);
    const qs = params.toString();
    setPendingLabel(label);
    startTransition(() => router.push(qs ? `${pathname}?${qs}` : pathname));
  }

  // Month select — clears any free range (mutually exclusive).
  function onMonth(value: string) {
    pushParams((p) => {
      if (value && /^\d{4}-\d{2}$/.test(value)) p.set("monthOverride", value);
      else p.delete("monthOverride");
      p.delete("from");
      p.delete("to");
    }, value ? formatMonthLabel(value) : "פריסה נוכחית");
  }

  // Free range — clears the month override. DateRangePicker fires onChange only
  // for a COMPLETE range (both bounds, already start ≤ end) or a clear (both
  // empty), so the half-range race that silently dropped one bound can't happen.
  function onRange(from: string, to: string) {
    pushParams((p) => {
      if (from) p.set("from", from); else p.delete("from");
      if (to) p.set("to", to); else p.delete("to");
      if (from || to) p.delete("monthOverride");
    }, from && to ? `${ddmm(from)}–${ddmm(to)}` : "פריסה נוכחית");
  }

  function clearAll() {
    pushParams((p) => {
      p.delete("monthOverride");
      p.delete("from");
      p.delete("to");
    }, "פריסה נוכחית");
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

  const appliedLabel = rangeActive
    ? `${ddmm(curFrom)}–${ddmm(curTo)}`
    : current
      ? formatMonthLabel(current)
      : "פריסה נוכחית";
  // While a navigation is in flight show the just-picked period, not the URL's
  // (stale until the transition resolves).
  const triggerLabel = isPending && pendingLabel ? pendingLabel : appliedLabel;

  return (
    <div className="dash-month-picker" dir="rtl" ref={ref}>
      <button
        type="button"
        className={
          "dash-dd-trigger" +
          (current || rangeActive ? " is-set" : "") +
          (isPending ? " is-pending" : "")
        }
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-busy={isPending || undefined}
        title="בחר חודש או טווח תאריכים חופשי"
      >
        {isPending ? (
          <span className="dash-dd-spin" aria-hidden />
        ) : (
          <span aria-hidden>📅</span>
        )}{" "}
        {triggerLabel}
        {isPending ? (
          <span className="dash-dd-updating">· מעדכן…</span>
        ) : (
          <span className="dash-dd-caret" aria-hidden>▾</span>
        )}
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
              bounds needed to take effect. Single-popover range calendar (same
              DateRangePicker as the /tasks filter): click start then end in one
              calendar, applied atomically via onChange → URL params. `key`
              re-seeds it from the URL after each apply / external clear. */}
          <div className="dash-dd-sep" />
          <div className={"dash-dd-range" + (rangeActive ? " is-active" : "")}>
            <span className="dash-dd-range-title">🗓️ טווח מותאם</span>
            <DateRangePicker
              key={`${curFrom}|${curTo}`}
              initialFrom={curFrom}
              initialTo={curTo}
              placeholder="בחר/י טווח תאריכים"
              onChange={(from, to) => {
                onRange(from, to);
                if (from && to) setOpen(false);
              }}
            />
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
