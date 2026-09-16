/**
 * BMBY warehouse → the CRM card's MEETING MAPS, on both bases (lib/
 * meetingBasis), for every BMBY route.
 *
 *   lead   (לפי כניסת ליד) — the OWNER-LEAD rule: each journey event
 *          belongs to its client's most recent lead created on or before
 *          the booking day, and counts in the window that lead arrived in,
 *          under that lead's own media_source_clean (its channel_key when
 *          blank — bmbyLeadSourceKey). What ALL CLIENTS
 *          counts: The 57, September, 20 תואמה (14 תואמו · 6 בוטלו) · 6
 *          פגישות, every channel row exact.
 *   dated  (לפי מועד הפגישה) — events whose appointment_date (booking
 *          date as fallback) is in the window, under the client's
 *          first-touch source: first_lid_source, then the first lead's
 *          media_source_clean, then first_lid_channel. The same event set
 *          as the ערוצים dated columns (lib/datedChannelMeetings), so Σ of
 *          the dated map = ProjectReportData.datedTotals.
 *
 * Both count every event in תואמה (cancelled included) and only a
 * BMBY-confirmed outcome in פגישות. The view's `held` boolean (confirmed +
 * status-inferred) is kept only as `estimatedHeld`, the old "כולל משוער".
 *
 * WHO CALLS THIS — lib/crmData's warehouse funnel, which fetches the full
 * lead history and journey once, builds both bases here, and reuses the
 * per-event owner assignments for the status stamps and the פילוח פייסבוק
 * drill. The maps then go to one of two cards:
 *   • the warehouse-routed card (the warehouse had at least the Sheet's
 *     leads for the window) — everything on it is warehouse;
 *   • a SHEET-routed BMBY card (owner decision D3): leads, statuses and
 *     objections stay the Sheet's, the meeting side is grafted from these
 *     maps — but only when the warehouse actually covers the window
 *     (`windowLeads`, `newestLeadDay`, `journeyEvents` below). A feed that
 *     stopped before the window can only produce zeros that look measured:
 *     on 2026-09-16 הרימון's last warehouse lead was 08-31 against 150
 *     Sheet leads in September, הוד השרון's 05-31, אור יהודה's 03-31.
 *     Those keep the Sheet snapshot, labelled as the D3 fallback.
 *
 * WHAT THIS REPLACED. A cached entry of five count queries for a "held
 * strip" under Sheet-routed tiles (confirmed / estimated / cancelled /
 * first bookings / freshness). The strip existed because Sheet tiles
 * counted lead STATUSES; once the tiles count warehouse events on both
 * bases it only repeated the dated ones, so CrmFunnelClient dropped it and
 * its "כולל משוער" is `dated.estimatedHeld`. The entry went with it: under
 * D3 a Sheet-routed card needs the owner-lead rule, i.e. the full history
 * the warehouse funnel already reads — and the only window that funnel
 * skips (no warehouse lead in it) is exactly one the warehouse does not
 * cover, so a separate read there could never be used.
 *
 * Never throws: the fetchers degrade to [] (supabaseRowsAll), which reads
 * as "no journey" / "no leads in the window", i.e. the fallback.
 */
import { supabaseRowsAll } from "./supabase";
import {
  assignOwnerLeads,
  bmbyEventCanceled,
  bmbyEventHeld,
  datedDay,
  dayInWindow,
  emptyMeetingTally,
  indexLeadsByClient,
  type BmbyMeetingEvent,
  type ClientLeadIndex,
  type DayWindow,
  type MeetingTally,
  type OwnerAssignment,
  type OwnerAssignmentTally,
  type OwnerLeadRow,
} from "./meetingBasis";
import type { CrmMeetingSourceMaps } from "./crmData";

/* ── Rows ─────────────────────────────────────────────────────────────── */

/** One v_bmby_leads_bucketed row as the meeting rules read it: the owner-
 *  lead index needs client / lead_id / creation time; the maps need the
 *  source; the פילוח פייסבוק drill needs the channel and UTM. */
export type BmbyHistoryLead = OwnerLeadRow & {
  media_source_clean: string | null;
  channel_key: string | null;
  utm_medium: string | null;
  utm_term: string | null;
  utm_content: string | null;
  utm_campaign: string | null;
};

/** One v_bmby_journey_meetings row. */
export type BmbyJourneyEvent = BmbyMeetingEvent & {
  /** The client's first-touch source string ("google-search-brand",
   *  "Article") — what the ערוצים dated columns attribute by. */
  first_lid_source: string | null;
  /** Its coarse bucket ("gs", "fb", "manual") — the last-resort key. */
  first_lid_channel: string | null;
  /** Confirmed OR status-inferred held. Over-counts; estimatedHeld only. */
  held: boolean | null;
};

/** A project's FULL lead history, lead_id order. Measured 2026-09-16: the
 *  largest BMBY project (נתיבות) holds 4,557 leads, far under the pager's
 *  20,000-row valve. */
export function fetchBmbyLeadHistory(projectId: number): Promise<BmbyHistoryLead[]> {
  return supabaseRowsAll<BmbyHistoryLead>(
    `v_bmby_leads_bucketed?project_id=eq.${projectId}` +
      `&select=client_id,lead_id,lead_created_at,media_source_clean,channel_key,utm_medium,utm_term,utm_content,utm_campaign` +
      `&order=lead_id.asc`,
  );
}

/** An account's FULL journey, every date — the owner-lead rule needs events
 *  booked long after their lead, and dated windows filter in memory.
 *  Keyed on project_he (the Hebrew account name): the view has no
 *  project_id. נתיבות, the largest, is 1,414 events. */
export function fetchBmbyJourneyEvents(account: string): Promise<BmbyJourneyEvent[]> {
  return supabaseRowsAll<BmbyJourneyEvent>(
    `v_bmby_journey_meetings?project_he=eq.${encodeURIComponent(account)}` +
      `&select=client_id,appointment_outcome,meeting_date,appointment_date,first_lid_source,first_lid_channel,held` +
      `&order=meeting_id.asc`,
  );
}

/* ── Maps ─────────────────────────────────────────────────────────────── */

/** Same normalisation as crmData's normSource (not importable from here
 *  without a runtime import cycle): collapsed whitespace, lower case, so
 *  "Facebook" and "facebook" are one chip. */
function normSource(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** day → source → counts, for the trendline. */
export type MeetingDaily = Record<string, Record<string, { scheduled: number; held: number }>>;

/** One basis' maps, in the CrmFunnel.sourceMatrices shape, plus what the
 *  funnel's scalar totals and trendline need. */
export type BmbyBasisMaps = CrmMeetingSourceMaps & {
  canceledMeetingsBySource: Record<string, number>;
  /** Window totals over EVERY counted event — including the rare one whose
   *  key is still blank (no media_source_clean AND no channel_key, see
   *  bmbyLeadSourceKey) and so sits in no map. The funnel's scalar
   *  scheduledMeetings / canceledMeetings / meetings. */
  totals: MeetingTally;
  /** Lead-entry: by the OWNER lead's Israel day (so the day buckets add up
   *  to the window, like the tiles). Dated: by the event's datedDay. */
  daily: MeetingDaily;
};

export type BmbyWarehouseMeetings = {
  lead: BmbyBasisMaps;
  dated: BmbyBasisMaps & {
    /** Dated events the view's `held` boolean marks held — confirmed plus
     *  status-inferred. Whole-window, not per source. */
    estimatedHeld: number;
  };
  /** The account's journey events, ALL dates. 0 = the warehouse knows the
   *  project but has no meeting journey for it (or the read failed): its
   *  zeros would be a missing feed, not a measurement, so a Sheet-routed
   *  card keeps its status snapshot (D3 fallback). */
  journeyEvents: number;
  /** History leads (with a client) whose Israel day is in the window — the
   *  pool every lead-entry owner comes from. 0 while the Sheet has leads
   *  means the warehouse lead feed does not reach this window. */
  windowLeads: number;
  /** The Israel day of the newest lead in the whole history ("" if none).
   *  Compared with the Sheet's newest window lead: a warehouse days behind
   *  it is missing the owners of the latest meetings. */
  newestLeadDay: string;
  /** How the owner-lead rule placed every event, all history — a data-
   *  quality readout (rule / first-lead / no-leads / no-client). The 57:
   *  67 / 1 / 6 / 0 of 74. */
  ownerTally: OwnerAssignmentTally;
};

function bumpMaps(
  into: BmbyBasisMaps,
  src: string,
  day: string,
  held: boolean,
  canceled: boolean,
): void {
  into.totals.scheduled++;
  if (held) into.totals.held++;
  if (canceled) into.totals.canceled++;
  if (!src) return;
  const add = (m: Record<string, number>) => (m[src] = (m[src] || 0) + 1);
  add(into.scheduledMeetingsBySource);
  if (held) add(into.meetingsBySource);
  if (canceled) add(into.canceledMeetingsBySource);
  if (!day) return;
  const perDay = (into.daily[day] ??= {});
  const cell = (perDay[src] ??= { scheduled: 0, held: 0 });
  cell.scheduled++;
  if (held) cell.held++;
}

const emptyMaps = (): BmbyBasisMaps => ({
  scheduledMeetingsBySource: {},
  meetingsBySource: {},
  canceledMeetingsBySource: {},
  totals: emptyMeetingTally(),
  daily: {},
});

/**
 * The source a BMBY LEAD is filed under on the lead-entry basis: its
 * media_source_clean, else its channel_key.
 *
 * The fallback is what ALL CLIENTS does. A lead with a blank
 * media_source_clean is not unfiled there — the feeder puts it on the
 * "Other" row, and channel_key reads "other" for exactly those leads.
 * Measured 2026-09-17: all 39 blank-source BMBY leads of August carry
 * channel_key "other"; on שלישייה על הפארק they are 8 leads whose owner-lead
 * events are 5 תואמה · 3 פגישות, and ALL CLIENTS' August "Other" row is 8
 * leads, 5/3 — every number. Keyed on the blank string, those events were
 * counted in the scalar tiles (38/19) but sat in no map (33/16), so the
 * past-month recount (D1) had nothing to put on "Other" and printed 0/0
 * there with no caption. As "other" they reach the row through the
 * attributor's case-folded exact match, or — on a project with no Other row
 * — the labelled unattributed remainder, like any other unplaced source.
 *
 * The dated key (bmbyDatedSourceKey) ends on first_lid_channel for the same
 * reason; channel_key is the lead-level spelling of that bucket.
 */
export function bmbyLeadSourceKey(
  lead: { media_source_clean: string | null; channel_key?: string | null } | null | undefined,
): string {
  return normSource(lead?.media_source_clean) || normSource(lead?.channel_key);
}

/** The first-touch source a DATED event is filed under. Mirrors
 *  datedChannelMeetings' first_lid_source → first_lid_channel, with the
 *  client's first lead in between (the same token family the lead map
 *  uses), so this map and the ערוצים dated columns file an event under the
 *  same source. Measured on The 57's 74 events (2026-09-16):
 *  normSource(first_lid_source) equals the first lead's media_source_clean
 *  on 64; 4 differ (a phone enquiry vs מדלן, the company site vs article);
 *  6 have no lead in the warehouse at all, which is when the fallback
 *  matters. */
export function bmbyDatedSourceKey(
  e: BmbyJourneyEvent,
  firstLead: BmbyHistoryLead | undefined,
): string {
  return (
    normSource(e.first_lid_source) ||
    normSource(firstLead?.media_source_clean) ||
    normSource(e.first_lid_channel)
  );
}

/**
 * Both bases' maps for one window, from an account's full lead history and
 * full journey. Pure. Also hands back the owner assignments and the lead
 * index, which the warehouse route reuses (status stamps, פילוח פייסבוק).
 */
export function buildBmbyWarehouseMeetings(
  history: readonly BmbyHistoryLead[],
  events: readonly BmbyJourneyEvent[],
  w: DayWindow,
): {
  meetings: BmbyWarehouseMeetings;
  assignments: OwnerAssignment<BmbyHistoryLead, BmbyJourneyEvent>[];
  index: ClientLeadIndex<BmbyHistoryLead>;
} {
  const index = indexLeadsByClient(history);
  const { assignments, tally } = assignOwnerLeads(index, events);

  // Coverage, off the days the index already computed.
  let windowLeads = 0;
  let newestLeadDay = "";
  for (const list of index.byClient.values()) {
    for (const l of list) {
      if (dayInWindow(l.day, w)) windowLeads++;
      if (l.day > newestLeadDay) newestLeadDay = l.day;
    }
  }

  const lead = emptyMaps();
  for (const a of assignments) {
    if (!a.owner || !dayInWindow(a.ownerDay, w)) continue;
    bumpMaps(
      lead,
      bmbyLeadSourceKey(a.owner),
      a.ownerDay,
      bmbyEventHeld(a.event),
      bmbyEventCanceled(a.event),
    );
  }

  const dated = { ...emptyMaps(), estimatedHeld: 0 };
  for (const e of events) {
    const day = datedDay(e);
    if (!dayInWindow(day, w)) continue;
    const first = index.first.get(String(e.client_id ?? "").trim())?.lead;
    bumpMaps(dated, bmbyDatedSourceKey(e, first), day, bmbyEventHeld(e), bmbyEventCanceled(e));
    if (e.held === true) dated.estimatedHeld++;
  }

  return {
    meetings: {
      lead,
      dated,
      journeyEvents: events.length,
      windowLeads,
      newestLeadDay,
      ownerTally: tally,
    },
    assignments,
    index,
  };
}
