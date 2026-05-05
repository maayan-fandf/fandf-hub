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

/** Statuses that count as "done" — filtered out of the agenda. */
const TERMINAL_STATUSES = new Set<WorkTaskStatus>(["done", "cancelled"]);

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
 * agenda for `userEmail`'s today. Empty array on any failure (the
 * panel renders an "אין משימות להיום" empty state — better than a
 * red error in the chrome of every page).
 */
export async function getAgendaForUser(
  userEmail: string,
): Promise<AgendaItem[]> {
  if (!userEmail) return [];
  let tasks: WorkTask[] = [];
  try {
    tasks = await todayTasksForUser(userEmail);
  } catch (e) {
    console.warn(
      "[agenda] getAgendaForUser failed:",
      e instanceof Error ? e.message : String(e),
    );
    return [];
  }

  const items: AgendaItem[] = tasks.map((t) => {
    const time = timeOfDay(t.requested_date);
    const subtitle = [t.company, t.project].filter(Boolean).join(" · ");
    return {
      id: t.id,
      source: "task",
      title: t.title || "(ללא כותרת)",
      time,
      toneClass: statusToneClass(t.status),
      href: `/tasks/${encodeURIComponent(t.id)}`,
      subtitle,
      status: t.status,
    };
  });

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
