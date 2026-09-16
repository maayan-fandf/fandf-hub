/**
 * Meeting-count BASIS — the one switch that decides what every תיאומים /
 * ביצועים number on the project page counts, and the pure rules both bases
 * are computed with.
 *
 * WHY ONE SWITCH. The page used to count meetings three different ways on
 * three different surfaces. The ערוצים table read ALL CLIENTS (lead-entry),
 * the קמפיינים joins read meeting EVENTS dated in the window, and the CRM
 * card read a third thing (cohort ∩ dated). The trigger case, measured
 * 2026-09-16 on The 57 in September: keyword "גיא ודורון לוי מתחם האלף"
 * showed 3 תיאומים · 1 ביצועים while the google-search row above it showed
 * 0 · 0, and both were "right". One client, one lead on 2026-08-25, four
 * meeting events: booked 08-26 for 08-28 (cancelled), booked 08-27 for
 * 09-04 (in process), booked 09-03 for 09-03 (cancelled), booked 09-03 for
 * 09-04 (held). By lead-entry all four belong to August (4/1) and September
 * is 0/0. By meeting date August has 1/0 and September 3/1.
 *
 * THE TWO BASES
 *
 *   "lead"  (default, no URL param) — לפי כניסת ליד. Meetings are credited
 *           to the period in which the LEAD that owns them arrived, whatever
 *           the meeting's own date. This is what ALL CLIENTS counts:
 *             BMBY  — the OWNER-LEAD rule (assignOwnerLeads below). Measured
 *                     exact against ALL CLIENTS on The 57 Sept (20/6, every
 *                     row) and within 11/3 over 113 rows of 14 projects.
 *                     Re-run through THIS module on live data 2026-09-16:
 *                     20/6 again, all 7 current rows exact (facebook 7/4,
 *                     article 6/0, yad2 3/1, google-discovery 2/1, מדלן
 *                     2/0, google-search 0/0, טלפוניה 0/0).
 *             Sehel — the REGISTRATION COHORT: every meeting event of a
 *                     client registered in the period. ביצועים = cohort
 *                     meetings whose status is exactly "הלקוח הגיע לפגישה"
 *                     (owner decision D2 — NOT the J-column mirror, which
 *                     also counted past meetings still at "לא ידוע").
 *             Salesforce — lead rows by current stage (the unit is LEADS).
 *   "dated" (?meetings=dated) — לפי מועד הפגישה. Meeting events whose date
 *           (appointment_date, falling back to meeting_date) is inside the
 *           period, whenever their lead arrived. See lib/datedChannelMeetings.
 *
 * Both rules count every event in תיאומים — including cancelled ones — and
 * only a CONFIRMED outcome in ביצועים.
 *
 * PAYLOAD CONVENTION (every report payload, no exceptions)
 *
 *   • A meeting field with NO prefix (`scheduled`, `meetings`, `held`,
 *     `costPerSched`, `scheduledMeetingsBySource` …) is LEAD-ENTRY.
 *   • The same field with a `dated` prefix (`datedScheduled`, `datedHeld`,
 *     `datedCostPerSched`, `sourceMatrices.dated` …) is MEETING-DATE.
 *   • `undefined` means THIS BASIS HAS NO SOURCE. Render "—" with the
 *     BASIS_COPY.dashNoSource tooltip (components/report/BasisBadge). Never
 *     fall back silently to the other basis — a lead-entry number under a
 *     "לפי מועד הפגישה" switch is exactly the disagreement this removes.
 *     A numeric 0 is the opposite: a source that was read and found nothing.
 *
 *   Both bases ship in the same payload and the swap happens at the client
 *   edge (lib/reportShared: applyBasisToChannels / applyBasisToCreatives /
 *   totalsForBasis), so flipping the switch never costs a request. The one
 *   exception to the prefix rule is the legacy export layer in
 *   lib/fbCreativeMeetingsExport (CreativeMeeting & co.), whose unprefixed
 *   fields stay DATED because /api/fb-creative-meetings must stay
 *   byte-identical; it carries `leadScheduled`/`leadHeld` instead.
 *
 * OWNER DECISIONS (2026-09-16, final — they override basis-design §5)
 *
 *   D1  Past months (?monthOverride): the ערוצים lead-entry תיאומים/ביצועים
 *       are the LIVE warehouse count (owner-lead / Sehel cohort) attributed
 *       to the rows the way range mode does — not the frozen חודשי literals.
 *       Leads and spend stay from ALL CLIENTS; Salesforce keeps its frozen
 *       numbers (no warehouse). Live mode keeps the ALL CLIENTS current row,
 *       which is pushed daily and matched the owner-lead rule exactly. No
 *       "הוקפאה" month note.
 *   D2  Sehel lead-entry ביצועים = status exactly SEHEL_HELD_STATUS
 *       (sehelLeadEntryHeld). תיאומים = all meeting events of the cohort.
 *   D3  Sheet-routed BMBY projects take their meeting maps from the
 *       WAREHOUSE on both bases (owner-lead / dated events), leads from the
 *       routed source. No project_id or journey in the warehouse → today's
 *       behaviour, labelled (FIXED_BADGES.warehouseFallback).
 *   D4  The switch is visible to clients.
 *
 * NO `@/` IMPORTS, NO IMPORTS AT ALL: this module has to run under
 * `node --experimental-strip-types` for the fixture tests, and it is shared
 * by server readers and client components alike. Keep it that way.
 */

/* ── The switch ───────────────────────────────────────────────────────── */

export type MeetingBasis = "lead" | "dated";

export const MEETING_BASES: readonly MeetingBasis[] = ["lead", "dated"];

/** The URL search param that carries the basis. Absent ⇒ "lead". Only the
 *  value "dated" is ever written, so a link without the param always opens
 *  on the default and one URL always shows one set of numbers. */
export const MEETING_BASIS_PARAM = "meetings";

export const DEFAULT_MEETING_BASIS: MeetingBasis = "lead";

/**
 * The basis a raw URL value asks for. Accepts what Next hands a page's
 * `searchParams` (string, string[] for a repeated param, or undefined) and
 * anything else without throwing. Only "dated" (case/space-insensitive)
 * selects the dated basis; everything else, including garbage, is lead-entry.
 */
export function parseMeetingBasis(v: unknown): MeetingBasis {
  const raw = Array.isArray(v) ? v[0] : v;
  return String(raw ?? "").trim().toLowerCase() === "dated" ? "dated" : "lead";
}

/** What a surface should actually render: the requested basis, unless the
 *  project has no dated source at all, in which case lead-entry. */
export function effectiveMeetingBasis(
  requested: MeetingBasis,
  datedAvailable: boolean,
): MeetingBasis {
  return requested === "dated" && datedAvailable ? "dated" : "lead";
}

/**
 * `href` with the basis param set (dated) or removed (lead), everything
 * else — path, other params, hash — kept. Works on relative hrefs
 * ("/projects/x?month=2026-08#crm") as well as absolute ones, which is what
 * the server-built links on the page (client preview, period reset) are.
 */
export function hrefWithMeetingBasis(href: string, basis: MeetingBasis): string {
  const hashAt = href.indexOf("#");
  const hash = hashAt >= 0 ? href.slice(hashAt) : "";
  const noHash = hashAt >= 0 ? href.slice(0, hashAt) : href;
  const qAt = noHash.indexOf("?");
  const path = qAt >= 0 ? noHash.slice(0, qAt) : noHash;
  const params = new URLSearchParams(qAt >= 0 ? noHash.slice(qAt + 1) : "");
  if (basis === "dated") params.set(MEETING_BASIS_PARAM, "dated");
  else params.delete(MEETING_BASIS_PARAM);
  const qs = params.toString();
  return path + (qs ? `?${qs}` : "") + hash;
}

/* ── Days ─────────────────────────────────────────────────────────────── */

/** A half-open day window [from, toExcl), both YYYY-MM-DD — the shape
 *  lib/fbCreativeMeetingsExport's MeetingsWindow already uses. Report
 *  windows are inclusive ({startIso, endIso}); convert with nextDay(). */
export type DayWindow = { from: string; toExcl: string };

/** YYYY-MM-DD + 1 day. Pure calendar arithmetic, no time zone involved. */
export function nextDay(day: string): string {
  const ms = Date.parse(`${day.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(ms)) return "";
  return new Date(ms + 86_400_000).toISOString().slice(0, 10);
}

export function dayInWindow(day: string, w: DayWindow): boolean {
  return !!day && day >= w.from && day < w.toExcl;
}

const IL_DAY_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jerusalem",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * The Israel calendar day (YYYY-MM-DD) of a timestamp, DST-correct.
 *
 * Replaces the fixed +3h shift in fbCreativeMeetingsExport/crmData `ilDay`,
 * which is right only in summer. In winter Israel is UTC+2, so a lead
 * created 21:00–22:00 UTC is 23:00–24:00 in Israel — still the same day —
 * and +3h files it on the NEXT day; on the last day of a month that moves
 * it into the next month. (22:00–23:00 UTC, the hour basis-design §2.2
 * names, is already the next Israel day and +3h happens to agree — the
 * fixture test checks both hours.) Intl knows the transition dates.
 *
 * Inputs:
 *   • a bare "YYYY-MM-DD" is already a calendar day and is returned as is;
 *   • a timestamp WITH a zone ("…Z", "…+00:00", "…+03") is converted;
 *   • a timestamp WITHOUT a zone is read as UTC. Left to Date.parse it would
 *     be read in the HOST's zone — UTC on App Hosting, Israel on the dev
 *     machine — and the same row would land on different days in dev/prod;
 *   • a Date or epoch-ms number is converted;
 *   • null / "" / unparseable → "" (callers treat "" as undated, never as a
 *     day that compares below every window).
 *
 * Measured 2026-09-16 (read-only probe): BMBY lead_created_at and Sehel
 * registered_at / starts_at all come back from PostgREST as "+00:00" TRUE
 * UTC. Sehel meeting start hours spread 05–17 UTC with a 07 peak (= 08–20
 * Israel, 10:00 peak), which a wall-clock reading (07:00 peak, nothing after
 * 16:00) cannot explain — so, despite an older comment in
 * fbCreativeMeetingsExport calling them wall-clock, Sehel days want this
 * function too, not a bare slice(0, 10). 69 of 1,952 Sehel registrations
 * since 2026-08-01 fall at 21:00–24:00 UTC, i.e. on the next Israel day.
 */
export function ilDayJerusalem(
  ts: string | number | Date | null | undefined,
): string {
  if (ts == null) return "";
  let ms: number;
  if (ts instanceof Date) ms = ts.getTime();
  else if (typeof ts === "number") ms = ts;
  else {
    const raw = String(ts).trim();
    if (!raw) return "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    const iso = raw.replace(" ", "T");
    // Postgres' text form may abbreviate the offset ("+03", "+0300"), which
    // Date.parse rejects; spell it "+03:00".
    const off = /([+-])(\d{2}):?(\d{2})?$/.exec(iso.slice(10));
    const zoned = /Z$/i.test(iso)
      ? iso
      : off
        ? `${iso.slice(0, iso.length - off[0].length)}${off[1]}${off[2]}:${off[3] ?? "00"}`
        : `${iso}Z`;
    ms = Date.parse(zoned);
  }
  if (!Number.isFinite(ms)) return "";
  let y = "", m = "", d = "";
  for (const p of IL_DAY_FMT.formatToParts(ms)) {
    if (p.type === "year") y = p.value;
    else if (p.type === "month") m = p.value;
    else if (p.type === "day") d = p.value;
  }
  return y && m && d ? `${y}-${m}-${d}` : "";
}

/* ── BMBY events ──────────────────────────────────────────────────────── */

/** The columns of v_bmby_journey_meetings every rule here reads. Both dates
 *  are `date` columns (no time, no zone). */
export type BmbyMeetingEvent = {
  client_id: string | number | null;
  appointment_outcome: string | null;
  /** When the meeting was BOOKED (see lib/heldMeetings). */
  meeting_date: string | null;
  /** When the meeting HAPPENS. Null on a minority of rows. */
  appointment_date: string | null;
};

/** The day an event is DATED on for the "dated" basis: when it happens,
 *  falling back to when it was booked. Same rule as datedChannelMeetings,
 *  crmData's meetingInWindow and fbCreativeMeetingsExport. "" when neither. */
export function datedDay(
  e: Pick<BmbyMeetingEvent, "appointment_date" | "meeting_date">,
): string {
  return String(e.appointment_date || e.meeting_date || "").slice(0, 10);
}

/** The day an event was BOOKED — what the owner-lead rule compares lead
 *  creation days against. Falls back to the appointment day. "" when neither. */
export function bookingDay(
  e: Pick<BmbyMeetingEvent, "appointment_date" | "meeting_date">,
): string {
  return String(e.meeting_date || e.appointment_date || "").slice(0, 10);
}

const outcomeOf = (e: Pick<BmbyMeetingEvent, "appointment_outcome">) =>
  String(e.appointment_outcome ?? "").trim().toLowerCase();

/** ביצוע: BMBY confirmed the meeting took place. NOT the view's `held`
 *  boolean, which adds status-inferred meetings (crmEnrichment's "משוער"). */
export function bmbyEventHeld(e: Pick<BmbyMeetingEvent, "appointment_outcome">): boolean {
  return outcomeOf(e) === "held";
}

/** בוטלו: the cancelled subset of תיאומים. */
export function bmbyEventCanceled(
  e: Pick<BmbyMeetingEvent, "appointment_outcome">,
): boolean {
  return outcomeOf(e) === "canceled";
}

/* ── BMBY owner-lead rule (lead-entry) ────────────────────────────────── */

/** The columns of v_bmby_leads_bucketed the owner-lead rule reads. Callers
 *  pass their own richer row type (UTM, media_source_clean …) and get the
 *  same object back as the owner. */
export type OwnerLeadRow = {
  client_id: string | number | null;
  lead_id: string | number | null;
  /** timestamptz — bucketed by its Israel day (ilDayJerusalem). */
  lead_created_at: string | null;
};

export type IndexedLead<L> = {
  lead: L;
  /** ilDayJerusalem(lead_created_at); "" when the lead has no usable date. */
  day: string;
  /** Numeric lead_id, or +Infinity when it has none (sorts last on ties). */
  ord: number;
  /** Input position — the final tie-break, so sorting is deterministic. */
  seq: number;
};

/**
 * A project's leads grouped per client, ready for assignOwnerLeads. Build it
 * ONCE per project from the FULL lead history (not a windowed slice — an
 * August lead owns September bookings) and reuse it for every window.
 */
export type ClientLeadIndex<L extends OwnerLeadRow> = {
  /** client → its dated leads, sorted by (Israel day, lead_id) ascending. */
  readonly byClient: ReadonlyMap<string, readonly IndexedLead<L>[]>;
  /** client → its lowest-lead_id lead, dated or not (the fallback owner). */
  readonly first: ReadonlyMap<string, IndexedLead<L>>;
};

const clientKey = (v: unknown) => String(v ?? "").trim();

function compareLeads<L>(a: IndexedLead<L>, b: IndexedLead<L>): number {
  if (a.ord !== b.ord) return a.ord < b.ord ? -1 : 1;
  return a.seq - b.seq;
}

export function indexLeadsByClient<L extends OwnerLeadRow>(
  leads: readonly L[],
): ClientLeadIndex<L> {
  const byClient = new Map<string, IndexedLead<L>[]>();
  const first = new Map<string, IndexedLead<L>>();
  leads.forEach((lead, seq) => {
    const c = clientKey(lead.client_id);
    if (!c) return;
    const n = Number(lead.lead_id);
    const rec: IndexedLead<L> = {
      lead,
      day: ilDayJerusalem(lead.lead_created_at),
      ord: lead.lead_id != null && lead.lead_id !== "" && Number.isFinite(n) ? n : Infinity,
      seq,
    };
    const f = first.get(c);
    if (!f || compareLeads(rec, f) < 0) first.set(c, rec);
    if (!rec.day) return;
    const list = byClient.get(c);
    if (list) list.push(rec);
    else byClient.set(c, [rec]);
  });
  for (const list of byClient.values()) {
    list.sort((a, b) =>
      a.day !== b.day ? (a.day < b.day ? -1 : 1) : compareLeads(a, b),
    );
  }
  return { byClient, first };
}

export type OwnerAssignment<L, E> = {
  event: E;
  /** The lead that owns this event; null when none can (see `via`). */
  owner: L | null;
  /** The owner's Israel creation day — the ONE bucket this event counts in
   *  on the lead-entry basis. "" when there is no owner, or the fallback
   *  owner has no date; such events count in no bucket. */
  ownerDay: string;
  /**
   *   "rule"       the most recent lead created on or before the booking day.
   *   "first-lead" no lead was created on or before the booking day (or the
   *                event has no date at all). NO owner — the event counts in
   *                no lead-entry bucket. Tallied for data quality only; see
   *                assignOwnerLeads for why it is not handed to a later lead.
   *   "no-leads"   the client has no lead in the index at all.
   *   "no-client"  the event carries no client_id.
   */
  via: "rule" | "first-lead" | "no-leads" | "no-client";
};

export type OwnerAssignmentTally = Record<OwnerAssignment<unknown, unknown>["via"], number>;

/**
 * The OWNER-LEAD rule — how ALL CLIENTS (BMBY דוח יחסי המרה) decides which
 * period a meeting event belongs to on the lead-entry basis:
 *
 *   owner(e) = the client's most recent lead whose Israel creation day is on
 *              or before the event's BOOKING day (meeting_date). Same-day
 *              tie → the higher lead_id. No such lead → no owner (tallied
 *              as "first-lead"): the event counts in no lead-entry bucket.
 *
 *              That last case was first handed to the client's first lead,
 *              which is created AFTER the booking — and so dropped a meeting
 *              booked in February 2025 into oz-blend's September 2026, and a
 *              July 2025 one into נתיבות's. Measured 2026-09-17 across 14
 *              BMBY projects' September rows against ALL CLIENTS: 108 of 122
 *              exact with that fallback, 113 of 122 without it.
 *
 * The event is then counted in the one bucket containing ownerDay and
 * credited to the OWNER lead's own source / UTM — not the client's first
 * touch, and not the event's own date. Because each event lands in exactly
 * one bucket, buckets are additive: Aug + Sept = the two-month window.
 *
 * O((L + E) log L). Every event comes back, in input order, so callers can
 * tally whatever dimensions they need (tallyLeadEntryEvents below).
 */
export function assignOwnerLeads<L extends OwnerLeadRow, E extends BmbyMeetingEvent>(
  index: ClientLeadIndex<L>,
  events: readonly E[],
): { assignments: OwnerAssignment<L, E>[]; tally: OwnerAssignmentTally } {
  const tally: OwnerAssignmentTally = { rule: 0, "first-lead": 0, "no-leads": 0, "no-client": 0 };
  const assignments: OwnerAssignment<L, E>[] = [];
  for (const event of events) {
    const c = clientKey(event.client_id);
    if (!c) {
      tally["no-client"]++;
      assignments.push({ event, owner: null, ownerDay: "", via: "no-client" });
      continue;
    }
    const first = index.first.get(c);
    if (!first) {
      tally["no-leads"]++;
      assignments.push({ event, owner: null, ownerDay: "", via: "no-leads" });
      continue;
    }
    const book = bookingDay(event);
    const list = index.byClient.get(c);
    let hit: IndexedLead<L> | undefined;
    if (book && list) {
      // Last index with day <= book (list is sorted by day, then lead_id,
      // so the last one on the booking day is also the highest lead_id).
      let lo = 0, hi = list.length - 1, at = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid].day <= book) { at = mid; lo = mid + 1; } else hi = mid - 1;
      }
      if (at >= 0) hit = list[at];
    }
    if (hit) {
      tally.rule++;
      assignments.push({ event, owner: hit.lead, ownerDay: hit.day, via: "rule" });
    } else {
      tally["first-lead"]++;
      assignments.push({ event, owner: null, ownerDay: "", via: "first-lead" });
    }
  }
  return { assignments, tally };
}

/* ── Tallies ──────────────────────────────────────────────────────────── */

/** One group's meeting counts on one basis. canceled ⊆ scheduled, held ⊆
 *  scheduled. */
export type MeetingTally = { scheduled: number; held: number; canceled: number };

export const emptyMeetingTally = (): MeetingTally => ({ scheduled: 0, held: 0, canceled: 0 });

/** A group key, several (an event credited to a creative AND an audience),
 *  or nothing (not counted in any group). */
export type GroupKeys = string | readonly string[] | null | undefined;

function bump(
  out: Map<string, MeetingTally>,
  keys: GroupKeys,
  held: boolean,
  canceled: boolean,
): void {
  if (keys == null) return;
  const list = typeof keys === "string" ? [keys] : keys;
  for (const k of list) {
    let t = out.get(k);
    if (!t) out.set(k, (t = emptyMeetingTally()));
    t.scheduled++;
    if (held) t.held++;
    if (canceled) t.canceled++;
  }
}

/**
 * Lead-entry tallies for one window: every assigned event whose OWNER was
 * created in `w`, grouped by `groupOf(owner, event)`. Events with no owner
 * or an undated owner count nowhere. Use "" (or any fixed key) as the group
 * for a plain total.
 */
export function tallyLeadEntryEvents<L extends OwnerLeadRow, E extends BmbyMeetingEvent>(
  assignments: readonly OwnerAssignment<L, E>[],
  w: DayWindow,
  groupOf: (owner: L, event: E) => GroupKeys,
): Map<string, MeetingTally> {
  const out = new Map<string, MeetingTally>();
  for (const a of assignments) {
    if (!a.owner || !dayInWindow(a.ownerDay, w)) continue;
    bump(out, groupOf(a.owner, a.event), bmbyEventHeld(a.event), bmbyEventCanceled(a.event));
  }
  return out;
}

/** Dated tallies for one window: every event whose datedDay is in `w`,
 *  grouped by `groupOf(event)` (first-touch lead, first_lid_source …). */
export function tallyDatedEvents<E extends BmbyMeetingEvent>(
  events: readonly E[],
  w: DayWindow,
  groupOf: (event: E) => GroupKeys,
): Map<string, MeetingTally> {
  const out = new Map<string, MeetingTally>();
  for (const e of events) {
    if (!dayInWindow(datedDay(e), w)) continue;
    bump(out, groupOf(e), bmbyEventHeld(e), bmbyEventCanceled(e));
  }
  return out;
}

/** Σ of a tally map — the window total across groups. Only meaningful when
 *  each event was credited to ONE group. */
export function sumMeetingTallies(m: ReadonlyMap<string, MeetingTally>): MeetingTally {
  const t = emptyMeetingTally();
  for (const v of m.values()) {
    t.scheduled += v.scheduled;
    t.held += v.held;
    t.canceled += v.canceled;
  }
  return t;
}

/* ── Sehel ────────────────────────────────────────────────────────────── */

/**
 * The one Sehel meeting status that is a ביצוע. `sehel_meetings.status_label`
 * vocabulary, measured over 1,272 meetings since 2026-01-01 (2026-09-16):
 *   status_id 10 "הלקוח הגיע לפגישה"  1,056
 *   status_id  0 "לא ידוע"               179
 *   status_id  5 "יש אישור הגעה"          26
 *   status_id 15 "הלקוח ביקש לבטל"        11
 * The id↔label pairing was 1:1 in every row, so `status_id === 10` (what
 * fbCreativeMeetingsExport selects) and this label are the same test.
 */
export const SEHEL_HELD_STATUS = "הלקוח הגיע לפגישה";

/**
 * Sehel lead-entry ביצוע (owner decision D2): the meeting's status is exactly
 * "הלקוח הגיע לפגישה". Surrounding whitespace is ignored, nothing else is —
 * "לא ידוע" past meetings are NOT counted, whatever their date.
 *
 * Sehel lead-entry תיאומים are every meeting event of the registration
 * cohort (clients whose registered_at Israel day is in the window), at any
 * meeting date and any status, cancelled included.
 */
export function sehelLeadEntryHeld(statusLabel: string | null | undefined): boolean {
  return String(statusLabel ?? "").trim() === SEHEL_HELD_STATUS;
}

/* ── Copy ─────────────────────────────────────────────────────────────── */

export const BASIS_LABELS: Record<MeetingBasis, string> = {
  lead: "לפי כניסת ליד",
  dated: "לפי מועד הפגישה",
};

/** The switch buttons' titles. The old ערוצים toggle's "מספר יציב שלא משתנה
 *  בדיעבד" claim is gone on purpose: outcomes are marked after the fact, so
 *  the dated ביצועים of the current month do move. */
export const BASIS_TITLES: Record<MeetingBasis, string> = {
  lead:
    "לפי מועד כניסת הליד — נספרות כל הפגישות (כולל שבוטלו) של לידים שנכנסו בתקופה, גם כשהפגישה עצמה אחרי סוף התקופה. המספר ממשיך לגדול גם אחרי סוף התקופה.",
  dated:
    "לפי מועד הפגישה — נספרות פגישות שמועדן בתוך התקופה, בלי קשר למתי נכנס הליד. תיאומים כוללים פגישות שבוטלו; ביצועים הן פגישות שסומנו כהתקיימו, ובחודש הנוכחי הן מתעדכנות בדיעבד.",
};

/** Every basis-dependent string on the page, keyed by where it goes. A
 *  `{lead, dated}` pair is picked with the effective basis; a surface must
 *  not hard-code its own variant of any of these. */
export const BASIS_COPY = {
  /** The switch (MeetingBasisToggle). */
  groupLabel: "ספירת פגישות:",
  groupAria: "בסיס ספירת התיאומים והביצועים בכל העמוד",
  datedDisabled: "אין לפרויקט מקור CRM עם מועדי פגישות — הספירה לפי כניסת ליד בלבד",

  /** "—" cell tooltips (BasisDash). `noSource[basis]` = the basis has no
   *  source for this project/platform; `crossBasis` = a ratio whose two
   *  sides would be counted on different bases (ליד→תיאום under dated). */
  dashNoSource: {
    lead: "אין נתון לפי כניסת ליד במקור ה-CRM של הפרויקט",
    dated: "אין נתון לפי מועד הפגישה במקור ה-CRM של הפרויקט",
  } satisfies Record<MeetingBasis, string>,
  dashCrossBasis: "יחס בין פגישות לפי מועד הפגישה ללידים לפי כניסה — אינו בר-השוואה",

  /** The ערוצים סה״כ block's extra row under dated, and the overview pie
   *  slice: dated meetings no table row could claim (unmatched + ambiguous). */
  unattributedRow: {
    label: "לא שויכו לשורה",
    title:
      "פגישות בתקופה שהמקור שלהן אינו אחת משורות הטבלה, או שנרשמו במקור כללי שאינו מבחין בין השורות",
  },

  /** ערוצים basisNote, Sehel + lead. Two variants because the two lead-entry
   *  sources disagree on held: the LIVE ALL CLIENTS row mirrors Sehel's J
   *  column (past meetings still at "לא ידוע" count), while every number the
   *  hub computes itself — past months (D1), joins, CRM tiles — counts
   *  "הלקוח הגיע לפגישה" only (D2). */
  sehelLeadHeldAllClients: "ב-Sehel ביצועים לפי כניסת ליד כוללים פגישות עבר ללא סטטוס סופי, כמו בדוח Sehel.",
  sehelLeadHeldStrict:
    "ב-Sehel ביצועים לפי כניסת ליד הם פגישות בסטטוס ״הלקוח הגיע לפגישה״ בלבד — פגישות עבר שעדיין בסטטוס ״לא ידוע״ אינן נספרות.",

  /** קמפיינים, Salesforce project under dated (the cards show "—"). */
  sfDatedCreatives: "ב-Salesforce אין שיוך פגישות למודעות לפי מועד הפגישה — הנתון מוצג לפי כניסת ליד בלבד.",

  /** CRM card פילוח פייסבוק basis line. `dated` is the text the card
   *  carried before the switch existed — accurate now that the tiles follow. */
  fbBreakdown: {
    lead:
      "לידים = נכנסו בטווח · תואמו/פגישות = כל אירועי הפגישה (כולל שבוטלו) של לידים שנכנסו בטווח, לפי המודעה של הליד שקבע את הפגישה — גם אם הפגישה אחרי הטווח. פגישות = מאושרות-בוצעו בלבד ב-BMBY.",
    dated:
      "לידים = נכנסו בטווח · תואמו/פגישות = אירועי פגישה שתאריכם בטווח, לפי המודעה שהביאה את הלקוח במגע הראשון (גם אם הליד נכנס לפני הטווח) — אותה הגדרה כמו אריחי המשפך. פגישות = מאושרות-בוצעו בלבד ב-BMBY, לכן בחודש הנוכחי הן מתעדכנות בדיעבד.",
  } satisfies Record<MeetingBasis, string>,

  /** Google Ads campaign chip title (קמפיינים). */
  googleCampaignChip: {
    lead:
      "תיאומים וביצועים של לידים שהקמפיין הזה הביא ונכנסו בתקופה, כולל פגישות שנקבעו אחריה — אותה הגדרה כמו בטבלת הערוצים",
    dated:
      "תיאומים וביצועים של הלידים שהקמפיין הזה הביא, לפי אירועי פגישה בתקופה — אותה הגדרה כמו במודעות פייסבוק",
  } satisfies Record<MeetingBasis, string>,

  /** AdHistoryPopover footnote (internal only). */
  adHistory: {
    lead:
      "כל שורה סופרת את הפגישות של לידים שנכנסו באותו חודש, לפי המודעה של הליד שקבע אותן — חודשים קודמים ממשיכים לגדול כשנקבעות פגישות חדשות.",
    dated:
      "תיאומים מיוחסים למודעה שהביאה את הליד, בכל גיל ליד — לכן המספר מצטבר גם אחרי שהמודעה הופסקה, ואינו בר-השוואה למספר שבכרטיס.",
  } satisfies Record<MeetingBasis, string>,

  /** ערוצים rangeNote, the outcomes sentence (rangeBasis.outcomes === "crm"). */
  rangeOutcomes: {
    lead: "לידים, תיאומים וביצועים נספרים מה-CRM ללידים שנכנסו בטווח.",
    dated: "לידים נספרים לפי כניסה לטווח; תיאומים וביצועים לפי מועד הפגישה בטווח.",
  } satisfies Record<MeetingBasis, string>,
  /** The same sentence under lead-entry when the CRM maps behind the
   *  columns are a status snapshot (rangeBasis.leadRule), keyed by why —
   *  the wording of FIXED_BADGES.statusSnapshot / warehouseFallback, which
   *  the CRM card wears for the same maps. */
  rangeOutcomesSnapshot: {
    statusSnapshot:
      "לידים נספרים מה-CRM ללידים שנכנסו בטווח; תיאומים וביצועים לפי הסטטוס הנוכחי של אותם לידים — יחידת הספירה היא לידים, לא אירועי פגישה.",
    warehouseFallback:
      "לידים נספרים מה-CRM ללידים שנכנסו בטווח. במחסן הנתונים אין לפרויקט נתוני פגישות של BMBY שמכסים את הטווח, ולכן תיאומים וביצועים הם לפי הסטטוס הנוכחי של אותם לידים — יחידת הספירה היא לידים, לא אירועי פגישה.",
  },

  /** Appended to the internal CRM alerts (crmAlerts), which are threshold
   *  signals on the current flight and never follow the switch. */
  alertsSuffix: "(לפי כניסת ליד, פריסה נוכחית)",
} as const;

export type FixedBadgeKey =
  | "trendLeadOnly"
  | "leadOnly"
  | "attemptedLeadOnly"
  | "statusFunnel"
  | "velocity"
  | "sourceTrigger"
  | "heldMeetings"
  | "statusSnapshot"
  | "warehouseFallback";

export type FixedBadge = {
  label: string;
  title: string;
  /** "fixed" — the surface has one basis by nature and always wears the
   *  badge. "lead-only" — shown only while the switch is on dated, where
   *  the surface cannot follow. "fallback" — a data-source caveat (amber). */
  tone: "fixed" | "lead-only" | "fallback";
};

/** The badges surfaces wear instead of following the switch. Rendered by
 *  <BasisBadge kind=… /> (components/report/BasisBadge). */
export const FIXED_BADGES: Record<FixedBadgeKey, FixedBadge> = {
  /** מגמות monthly trend under dated. */
  trendLeadOnly: {
    label: "לפי כניסת ליד בלבד",
    title: "אין היסטוריה חודשית לפי מועד הפגישה — הגרף נשאר לפי כניסת ליד",
    tone: "lead-only",
  },
  /** Generic lead-only surface under dated (forecast pills, deltas' tooltips). */
  leadOnly: {
    label: "לפי כניסת ליד בלבד",
    title: "לנתון הזה אין גרסה לפי מועד הפגישה — הוא נשאר לפי כניסת ליד",
    tone: "lead-only",
  },
  /** Salesforce ניסיון תיאום פגישה tile under dated. */
  attemptedLeadOnly: {
    label: "לפי כניסת ליד בלבד",
    title: "ניסיון תיאום פגישה הוא סטטוס של ליד ב-Salesforce, ואין לו מועד פגישה",
    tone: "lead-only",
  },
  statusFunnel: {
    label: "לפי כניסת ליד",
    title: "משפך הסטטוסים מתאר את הסטטוס הנוכחי של כל ליד",
    tone: "fixed",
  },
  velocity: {
    label: "לפי כניסת ליד",
    title: "מסע הליד נמדד מרגע כניסת הליד",
    tone: "fixed",
  },
  sourceTrigger: {
    label: "לפי מועד התיאום",
    title: "נספרים תיאומים לפי היום שבו נקבעה הפגישה",
    tone: "fixed",
  },
  /** פגישות שהתקיימו (MeetingsSection). Its explanatory ct-note stays. */
  heldMeetings: {
    label: "תמיד לפי מועד הפגישה",
    title: "רשימת הפגישות שהתקיימו נספרת תמיד לפי מועד קיומן, בלי קשר לבחירה בראש העמוד",
    tone: "fixed",
  },
  /** CRM card on a Sheet route whose lead-entry maps are a status snapshot
   *  (Sehel Sheet, Salesforce): the unit is leads, not meeting events. */
  statusSnapshot: {
    label: "לפי סטטוס ליד",
    title:
      "תואמה ופגישות נספרים לפי הסטטוס הנוכחי של הלידים שנכנסו בתקופה — יחידת הספירה היא לידים, לא אירועי פגישה",
    tone: "fallback",
  },
  /** D3 fallback: a Sheet-routed BMBY project whose maps stay the Sheet's
   *  status snapshot because the warehouse cannot count its meetings for
   *  this period — no project_id or journey at all, OR a lead feed that
   *  stops short of the window (lib/crmData warehouseCoversWindow). The
   *  second case is real: on 2026-09-16 הרימון's newest warehouse lead
   *  was 08-31 against 150 Sheet leads in September, הוד השרון stopped at
   *  05-31 and אור יהודה at 03-31, so the owner-lead count would be 0 by
   *  construction — which is why the wording names the PERIOD, not the
   *  project. */
  warehouseFallback: {
    label: "לפי סטטוס ליד",
    title:
      "במחסן הנתונים אין לפרויקט נתוני פגישות של BMBY שמכסים את התקופה הזו, ולכן תואמה ופגישות נספרים כאן לפי הסטטוס הנוכחי של הלידים שנכנסו בתקופה — יחידת הספירה היא לידים, לא אירועי פגישה, ואין ספירה לפי מועד הפגישה",
    tone: "fallback",
  },
};

/** Same output as reportShared's fmtInt, which this module cannot import. */
const HE_INT = new Intl.NumberFormat("he-IL", { maximumFractionDigits: 0 });

const heCount = (n: number, one: string, many: string): string =>
  n === 1 ? one : `${HE_INT.format(Math.round(n || 0))} ${many}`;

/**
 * The internal line under a platform's group cards: meetings of fb/gs OWNER
 * leads that carried no usable UTM, so no creative / audience / keyword row
 * could take them. They are why Σ rows sits below the ערוצים row.
 * Hebrew takes the singular at exactly one ("1 תיאומים" is wrong).
 */
export function untaggedMeetingsLine(scheduled: number, held: number): string {
  return `עוד ${heCount(scheduled, "תיאום אחד", "תיאומים")} · ${heCount(held, "ביצוע אחד", "ביצועים")} מלידים ללא תגית UTM`;
}
