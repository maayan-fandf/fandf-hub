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
async function todayCalendarEvents(userEmail: string): Promise<AgendaItem[]> {
  try {
    const { startIso, endIso } = todayBoundsIsrael();
    const cal = calendarReadonlyClient(userEmail);
    const res = await cal.events.list({
      calendarId: "primary",
      timeMin: startIso,
      timeMax: endIso,
      singleEvents: true, // expand recurring events into individual instances
      orderBy: "startTime",
      maxResults: 50,
    });
    const events = res.data.items ?? [];
    return events.map((e): AgendaItem => {
      // start.dateTime when the event has a specific time; start.date
      // (YYYY-MM-DD only) for all-day events.
      const startDt = e.start?.dateTime || "";
      const time = startDt
        ? new Intl.DateTimeFormat("en-GB", {
            timeZone: "Asia/Jerusalem",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }).format(new Date(startDt))
        : "";
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
 * Pull today's tasks for `userEmail` — uses the existing
 * `relevant_to_me` filter on `tasksListDirect`, which OR's across
 * (author | approver | assignee). Project-manager-only tasks come
 * through too via the broader `involved_with` route — but we keep
 * the agenda focused on the smaller set so it doesn't bloat with
 * tasks the user only needs to know about peripherally.
 *
 * Terminal statuses (done/cancelled) get filtered client-side since
 * tasksListDirect doesn't expose an excludeResolved flag.
 */
async function todayTasksForUser(userEmail: string): Promise<WorkTask[]> {
  const today = todayIsraelDate();
  const res = await tasksListDirect(userEmail, {
    relevant_to_me: userEmail,
    requested_date_from: today,
    requested_date_to: today,
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
 * Public entry point for the panel. Returns a sorted, render-ready
 * agenda for `userEmail`'s today — tasks + Google Calendar events,
 * merged. Empty array on any failure (the panel renders an "אין
 * משימות להיום" empty state — better than a red error in the chrome
 * of every page).
 */
export async function getAgendaForUser(
  userEmail: string,
): Promise<AgendaItem[]> {
  if (!userEmail) return [];
  // Run task + calendar fetches in parallel — independent reads. The
  // calendar half is wrapped in its own try/catch so a calendar error
  // doesn't kill the task half (e.g., DWD scope issue would degrade
  // gracefully to tasks-only).
  let tasks: WorkTask[] = [];
  let events: AgendaItem[] = [];
  try {
    [tasks, events] = await Promise.all([
      todayTasksForUser(userEmail),
      todayCalendarEvents(userEmail),
    ]);
  } catch (e) {
    console.warn(
      "[agenda] getAgendaForUser failed:",
      e instanceof Error ? e.message : String(e),
    );
    return [];
  }

  const taskItems: AgendaItem[] = tasks.map((t) => {
    const time = timeOfDay(t.requested_date);
    const subtitle = [t.company, t.project].filter(Boolean).join(" · ");
    return {
      id: `task:${t.id}`,
      source: "task",
      title: t.title || "(ללא כותרת)",
      time,
      toneClass: statusToneClass(t.status),
      href: `/tasks/${encodeURIComponent(t.id)}`,
      subtitle,
      status: t.status,
    };
  });

  const items: AgendaItem[] = [...taskItems, ...events];

  // Time-sorted: items with a time come first (chronological); items
  // without a time follow as "כל היום". Within each band, ties break
  // alphabetically by title for stable order.
  items.sort((a, b) => {
    const aTimed = !!a.time;
    const bTimed = !!b.time;
    if (aTimed !== bTimed) return aTimed ? -1 : 1;
    if (aTimed && bTimed) return a.time.localeCompare(b.time);
    return a.title.localeCompare(b.title, "he");
  });

  return items;
}
