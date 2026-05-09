/**
 * Server-side data layer for the right-rail Agenda Panel.
 *
 * Phase A (this file, 2026-05-05): merges today's hub tasks for the
 * caller — assigned, approving, or PM'ing — into a unified time-sorted
 * list. Calendar events come in Phase B once the calendar.events.readonly
 * scope is granted (either via Workspace DWD admin or NextAuth user
 * OAuth re-consent — pending decision).
 *
 * "Today" is Israel-local (Asia/Jerusalem). The hub stores
 * `requested_date` as YYYY-MM-DD or YYYY-MM-DDTHH:MM (no timezone
 * suffix, treated as Israel time by convention). We compute today's
 * date as a YYYY-MM-DD string in Israel locale and pass it as the
 * date-range filter — `tasksListDirect` already supports
 * `requested_date_from` / `requested_date_to`.
 *
 * Returns a list of `AgendaItem` ready for direct render. The
 * component just maps over it.
 */

import { tasksListDirect } from "@/lib/tasksDirect";
import { calendarReadonlyClient } from "@/lib/sa";
import type { WorkTask, WorkTaskStatus } from "@/lib/appsScript";

export type AgendaItem = {
  /** Stable key for React. */
  id: string;
  /** Discriminator — only "task" today; "event" comes in Phase B. */
  source: "task" | "event";
  /** Render text. For tasks, this is the task title. */
  title: string;
  /** Optional time-of-day label ("14:30") if the source carries a
   *  specific time, else empty (the item renders under "כל היום"). */
  time: string;
  /** Hex/CSS color hint for the leading dot. Tasks color by status;
   *  events (Phase B) will pull their own calendar color. */
  toneClass: string;
  /** Click destination — task detail page for tasks, event link for
   *  calendar items. */
  href: string;
  /** Subtitle line — for tasks: "company / project". Optional. */
  subtitle: string;
  /** Status pill text — only for tasks. Empty for events. */
  status?: WorkTaskStatus;
  /** Full WorkTask payload — only present for source="task". The
   *  agenda's row component passes this to TaskPreviewProvider when
   *  the user clicks the 👁 button so the quick-view drawer doesn't
   *  need a re-fetch. */
  task?: WorkTask;
};

/** A day's worth of agenda items, ready for the panel's day-grouped
 *  render. `date` is YYYY-MM-DD in Israel-local; `items` are pre-
 *  sorted (timed first, then all-day, alphabetical within each band). */
export type AgendaDay = {
  /** YYYY-MM-DD (Israel-local) — used as the section's anchor id so
   *  the panel can auto-scroll to today on mount. */
  date: string;
  /** Hebrew display label for the day section header — "היום",
   *  "מחר", "אתמול", or a localized "יום שני 10 במאי" for further
   *  out. */
  dayLabel: string;
  /** Whether this section represents today (the panel scrolls to
   *  this section on mount). */
  isToday: boolean;
  /** Sorted, render-ready items. */
  items: AgendaItem[];
};

/**
 * Today (Israel-local), formatted as YYYY-MM-DD.
 *
 * The hub stores `requested_date` as YYYY-MM-DD (no timezone) and
 * compares string-wise; matching against Israel-local "today" gives
 * the right behaviour even when the server clock is UTC.
 */
function todayIsraelDate(now: Date = new Date()): string {
  // en-CA gives the YYYY-MM-DD ordering we need without manual padding.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(now);
}

/** Israel-local midnight at the start of today + tomorrow, as Date
 *  objects in UTC (the calendar API takes RFC3339 timestamps with
 *  timezone offsets). Used to bound the events.list query. */
function todayBoundsIsrael(now: Date = new Date()): {
  startIso: string;
  endIso: string;
} {
  // We need start = 00:00 Israel today, end = 00:00 Israel tomorrow.
  // Compute "today's date in Israel" then construct ISO timestamps
  // anchored to Asia/Jerusalem. Using Intl + manual offset stitching
  // keeps the math straightforward without pulling in a date lib.
  const dayKey = todayIsraelDate(now); // "YYYY-MM-DD" in Israel
  // Israel is UTC+2 (winter) / UTC+3 (summer). To stay correct across
  // DST without hardcoding, we round-trip through Intl: build a Date
  // from the YYYY-MM-DD as if-UTC, then compute the offset Asia/
  // Jerusalem applies to that instant.
  const startUtcCandidate = new Date(`${dayKey}T00:00:00Z`);
  const startIso = adjustToIsraelMidnight(startUtcCandidate);
  // Tomorrow is +1 day in Israel — easiest to compute via `new Date`
  // arithmetic on the candidate: add 24h to startUtcCandidate then
  // adjust again (handles DST by re-evaluating the offset).
  const endUtcCandidate = new Date(
    startUtcCandidate.getTime() + 24 * 60 * 60 * 1000,
  );
  const endIso = adjustToIsraelMidnight(endUtcCandidate);
  return { startIso, endIso };
}

/** Subtract Israel's UTC offset for the given instant from the UTC
 *  midnight, so the resulting ISO actually represents Israel-local
 *  midnight. Handles DST transitions naturally because we re-read
 *  the offset for each instant. */
function adjustToIsraelMidnight(utcMidnight: Date): string {
  // Find Israel-local representation of the UTC midnight, then walk
  // back the difference. Use Intl to read what "the time in Israel"
  // would say at this UTC instant.
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(utcMidnight);
  const map: Record<string, string> = {};
  for (const p of parts) if (p.type !== "literal") map[p.type] = p.value;
  const localStr = `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}Z`;
  const localAsUtc = new Date(localStr);
  // The offset is local-as-UTC minus the original UTC instant.
  const offsetMs = localAsUtc.getTime() - utcMidnight.getTime();
  // To get true Israel-local-midnight as a UTC ISO, walk the candidate
  // BACK by the offset.
  const result = new Date(utcMidnight.getTime() - offsetMs);
  return result.toISOString();
}

/** Statuses that count as "done" — filtered out of the agenda. */
const TERMINAL_STATUSES = new Set<WorkTaskStatus>(["done", "cancelled"]);

/**
 * Pull today's events from `userEmail`'s primary Google Calendar.
 * Uses the narrow `calendar.events.readonly` scope via the SA's
 * domain-wide delegation (added 2026-05-05). Best-effort: any error
 * returns an empty array so the agenda still renders the task half.
 */
async function calendarEventsInRange(
  userEmail: string,
  fromDate: string,
  toDate: string,
): Promise<Array<AgendaItem & { _date: string }>> {
  try {
    // Israel-local midnight at start of fromDate → end of toDate
    // (i.e. day after toDate).
    const startUtc = new Date(`${fromDate}T00:00:00Z`);
    const startIso = adjustToIsraelMidnight(startUtc);
    const endBoundary = new Date(`${toDate}T00:00:00Z`);
    endBoundary.setUTCDate(endBoundary.getUTCDate() + 1);
    const endIso = adjustToIsraelMidnight(endBoundary);
    const cal = calendarReadonlyClient(userEmail);
    const res = await cal.events.list({
      calendarId: "primary",
      timeMin: startIso,
      timeMax: endIso,
      singleEvents: true, // expand recurring events into individual instances
      orderBy: "startTime",
      maxResults: 250,
    });
    const events = res.data.items ?? [];
    return events.map((e): AgendaItem & { _date: string } => {
      // start.dateTime when the event has a specific time; start.date
      // (YYYY-MM-DD only) for all-day events.
      const startDt = e.start?.dateTime || "";
      const startDate = e.start?.date || "";
      const time = startDt
        ? new Intl.DateTimeFormat("en-GB", {
            timeZone: "Asia/Jerusalem",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }).format(new Date(startDt))
        : "";
      // Bucket date — for timed events use the Israel-local date of
      // the start instant; for all-day events use the supplied date.
      const dayKey = startDt
        ? new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Jerusalem",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(new Date(startDt))
        : startDate || "";
      // Subtitle: location, or organizer when present, else empty.
      const subtitle = e.location
        ? String(e.location)
        : e.organizer?.displayName
          ? `מארגן: ${e.organizer.displayName}`
          : "";
      return {
        id: `event:${e.id || ""}`,
        source: "event",
        title: e.summary || "(אירוע ללא כותרת)",
        time,
        toneClass: "agenda-tone-event",
        href: e.htmlLink || "https://calendar.google.com/",
        subtitle,
        _date: dayKey,
      };
    });
  } catch (err) {
    console.warn(
      "[agenda] calendar fetch failed (continuing with tasks only):",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

/**
 * Pull tasks for `userEmail` whose `requested_date` falls in the
 * inclusive [fromDate, toDate] range (YYYY-MM-DD strings). Same
 * `relevant_to_me` scope as the legacy single-day variant: OR
 * across (author | approver | assignee).
 *
 * Terminal statuses (done/cancelled) get filtered client-side since
 * tasksListDirect doesn't expose an excludeResolved flag.
 */
async function tasksForUserInDateRange(
  userEmail: string,
  fromDate: string,
  toDate: string,
): Promise<WorkTask[]> {
  const res = await tasksListDirect(userEmail, {
    relevant_to_me: userEmail,
    requested_date_from: fromDate,
    requested_date_to: toDate,
  });
  return res.tasks.filter((t) => !TERMINAL_STATUSES.has(t.status));
}

/** Extract the hour:minute portion of `requested_date` if it's an ISO
 *  with a time component; otherwise empty string. */
function timeOfDay(requestedDate: string): string {
  const m = requestedDate.match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : "";
}

/** Map status → CSS tone class. Mirrors `tasks-status-*` palette. */
function statusToneClass(s: WorkTaskStatus): string {
  return `agenda-tone-${s}`;
}

/**
 * Public entry point for the panel. Returns the agenda grouped by
 * day for the window [today − daysBefore, today + daysAfter]. The
 * panel renders each AgendaDay as its own section with a header,
 * lets the user scroll across days, and auto-scrolls to today on
 * mount.
 *
 * Always returns one entry per day in the window (even days with no
 * items) so the section anchors exist for the auto-scroll target +
 * visual day-by-day rhythm.
 */
export async function getAgendaForUserDays(
  userEmail: string,
  opts: { daysBefore?: number; daysAfter?: number } = {},
): Promise<AgendaDay[]> {
  if (!userEmail) return [];
  const daysBefore = Math.max(0, Math.floor(opts.daysBefore ?? 1));
  const daysAfter = Math.max(0, Math.floor(opts.daysAfter ?? 6));
  const today = todayIsraelDate();
  // Build the YYYY-MM-DD date keys for each day in the window.
  const dates = buildDateRange(today, daysBefore, daysAfter);
  const fromDate = dates[0];
  const toDate = dates[dates.length - 1];

  let tasks: WorkTask[] = [];
  let events: Array<AgendaItem & { _date: string }> = [];
  try {
    [tasks, events] = await Promise.all([
      tasksForUserInDateRange(userEmail, fromDate, toDate),
      calendarEventsInRange(userEmail, fromDate, toDate),
    ]);
  } catch (e) {
    console.warn(
      "[agenda] getAgendaForUserDays failed:",
      e instanceof Error ? e.message : String(e),
    );
    return dates.map((d) => emptyDay(d, today));
  }

  // Bucket tasks by their requested_date's YYYY-MM-DD prefix.
  const taskItemsByDate = new Map<string, AgendaItem[]>();
  for (const t of tasks) {
    const dayKey = (t.requested_date || "").slice(0, 10);
    if (!dayKey) continue;
    const time = timeOfDay(t.requested_date);
    const subtitle = [t.company, t.project].filter(Boolean).join(" · ");
    const item: AgendaItem = {
      id: `task:${t.id}`,
      source: "task",
      title: t.title || "(ללא כותרת)",
      time,
      toneClass: statusToneClass(t.status),
      href: `/tasks/${encodeURIComponent(t.id)}`,
      subtitle,
      status: t.status,
      task: t,
    };
    const list = taskItemsByDate.get(dayKey) ?? [];
    list.push(item);
    taskItemsByDate.set(dayKey, list);
  }

  // Bucket events similarly. _date was already computed by the
  // calendar fetch above.
  const eventItemsByDate = new Map<string, AgendaItem[]>();
  for (const e of events) {
    if (!e._date) continue;
    const list = eventItemsByDate.get(e._date) ?? [];
    // Strip the helper field before pushing — keep the public shape.
    const { _date: _strip, ...item } = e;
    void _strip;
    list.push(item);
    eventItemsByDate.set(e._date, list);
  }

  return dates.map((d): AgendaDay => {
    const items = [
      ...(taskItemsByDate.get(d) ?? []),
      ...(eventItemsByDate.get(d) ?? []),
    ];
    items.sort((a, b) => {
      const aTimed = !!a.time;
      const bTimed = !!b.time;
      if (aTimed !== bTimed) return aTimed ? -1 : 1;
      if (aTimed && bTimed) return a.time.localeCompare(b.time);
      return a.title.localeCompare(b.title, "he");
    });
    return {
      date: d,
      dayLabel: formatDayLabel(d, today),
      isToday: d === today,
      items,
    };
  });
}

/**
 * Legacy single-day variant — still exported so existing call sites
 * (if any) keep working. New code should prefer getAgendaForUserDays.
 */
export async function getAgendaForUser(
  userEmail: string,
): Promise<AgendaItem[]> {
  const days = await getAgendaForUserDays(userEmail, {
    daysBefore: 0,
    daysAfter: 0,
  });
  return days[0]?.items ?? [];
}

function buildDateRange(
  todayKey: string,
  daysBefore: number,
  daysAfter: number,
): string[] {
  const out: string[] = [];
  const base = new Date(`${todayKey}T00:00:00Z`);
  for (let i = -daysBefore; i <= daysAfter; i++) {
    const d = new Date(base.getTime());
    d.setUTCDate(d.getUTCDate() + i);
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Jerusalem",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    out.push(fmt.format(d));
  }
  return out;
}

function emptyDay(date: string, todayKey: string): AgendaDay {
  return {
    date,
    dayLabel: formatDayLabel(date, todayKey),
    isToday: date === todayKey,
    items: [],
  };
}

/** Hebrew display label for a day section. "אתמול" / "היום" / "מחר"
 *  for ±1; otherwise localized weekday + day + month. */
function formatDayLabel(date: string, todayKey: string): string {
  const today = new Date(`${todayKey}T00:00:00Z`);
  const target = new Date(`${date}T00:00:00Z`);
  const dayDelta = Math.round(
    (target.getTime() - today.getTime()) / (24 * 60 * 60 * 1000),
  );
  if (dayDelta === 0) return "היום";
  if (dayDelta === 1) return "מחר";
  if (dayDelta === -1) return "אתמול";
  if (dayDelta === 2) return "מחרתיים";
  if (dayDelta === -2) return "שלשום";
  const fmt = new Intl.DateTimeFormat("he-IL", {
    timeZone: "Asia/Jerusalem",
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  return fmt.format(target);
}
