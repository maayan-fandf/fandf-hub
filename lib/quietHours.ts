/**
 * Quiet-hours helper for Google Tasks creation + auto-transition.
 *
 * Goal: stop the hub from spawning Google Tasks (or auto-transitioning
 * the hub task) outside Israel work hours. The 2026-05-05 incident
 * surfaced the cost: a 9pm GT spawn pinged sapir's phone, she
 * dismissed it (the only "remove from list" affordance), and the
 * dismissal was indistinguishable from an honest "I finished the work"
 * completion — the hub auto-transitioned the task to ממתין לאישור.
 *
 * Quiet-hours definition (Israel local time):
 *   - Weekdays (Sun–Thu): quiet 19:00 → 08:59
 *   - Friday: quiet from 14:00 onward
 *   - Saturday: quiet all day
 *
 * Notes / Holidays:
 *   - Public Israeli holidays aren't modelled here (they'd need a
 *     hard-coded list or a calendar API integration). Acceptable for
 *     v1; the worst case is one day of "noisy" notifications.
 *   - Times are NOT user-configurable per-person. v2 might surface a
 *     pref toggle, but right now the hub doesn't pass user-level
 *     preferences this deep into the create path.
 *
 * Used by:
 *   - lib/tasksWriteDirect.ts → createGoogleTasks shifts the GT's
 *     `due` field to the next work-hour and adds a quiet-hours note
 *   - lib/autoTransition.ts → applyAutoTransition skips during quiet
 *     hours (with reason "deferred — quiet hours"); pollTaskCompletions
 *     re-tries on the next poll cycle, when the hour rolls into the
 *     work window
 */

/** Number-of-hours that 0–23 is the local hour in Israel right now. */
function israelHour(now: Date = new Date()): { hour: number; day: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem",
    hour: "numeric",
    weekday: "short",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const wk = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const map: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return { hour: h % 24, day: map[wk] ?? 1 };
}

/** True when `now` falls inside the quiet window. */
export function isQuietHours(now: Date = new Date()): boolean {
  const { hour, day } = israelHour(now);
  if (day === 6) return true;             // Saturday all day
  if (day === 5 && hour >= 14) return true; // Friday afternoon onwards
  if (hour < 9 || hour >= 19) return true;  // Weekday outside 09:00–18:59
  return false;
}

/**
 * Returns the next moment that is NOT quiet hours, as a Date object
 * in UTC (the API consumers convert to whatever format they need).
 *
 * Mid-week at 9pm Tuesday → next 9am Wednesday.
 * Friday 18:00 → next 9am Sunday.
 * Saturday at any hour → next 9am Sunday.
 */
export function nextWorkHour(now: Date = new Date()): Date {
  // Walk forward an hour at a time until we land in a non-quiet hour.
  // Cheap (max ~36 iterations to span Friday-afternoon → Sunday-9am)
  // and entirely timezone-safe — no DST math required because we
  // always re-check Asia/Jerusalem each step.
  const out = new Date(now);
  for (let i = 0; i < 96; i++) {
    if (!isQuietHours(out)) return out;
    out.setUTCMinutes(0, 0, 0);
    out.setUTCHours(out.getUTCHours() + 1);
  }
  // Defensive fallback — shouldn't hit. Add 24h.
  return new Date(now.getTime() + 24 * 60 * 60 * 1000);
}

/** ISO date-only (`YYYY-MM-DD`) helper for Google Tasks `due` field
 *  — Tasks API ignores time-of-day on the `due` field anyway, but
 *  setting an explicit date makes the task land in the user's
 *  "Today" / "Upcoming" buckets correctly when work-hours arrive. */
export function nextWorkDateIso(now: Date = new Date()): string {
  const d = nextWorkHour(now);
  // YYYY-MM-DD in Asia/Jerusalem.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d);
}
