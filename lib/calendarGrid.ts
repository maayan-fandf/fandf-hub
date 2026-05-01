/**
 * Shared calendar primitives for DatePicker + DateRangePicker.
 * Pure functions; importable from any component.
 */

export const WEEKDAY_LABELS_HE = ["א", "ב", "ג", "ד", "ה", "ו", "ש"];
export const MONTH_NAMES_HE = [
  "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
  "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
];

export function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseIso(s: string): Date | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function monthLabel(d: Date): string {
  return `${MONTH_NAMES_HE[d.getMonth()]} ${d.getFullYear()}`;
}

export type CalDay = { iso: string; day: number; otherMonth: boolean };

/** 6×7 grid of days for the given month, padded with leading + trailing
 *  days from neighboring months so the calendar always renders 42 cells.
 *  Sunday-first (he-IL convention). */
export function buildMonthGrid(viewMonth: Date): CalDay[] {
  const first = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
  const firstDow = first.getDay(); // 0=Sun … 6=Sat
  const start = new Date(first);
  start.setDate(start.getDate() - firstDow);
  const grid: CalDay[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    grid.push({
      iso: isoDate(d),
      day: d.getDate(),
      otherMonth: d.getMonth() !== viewMonth.getMonth(),
    });
  }
  return grid;
}
