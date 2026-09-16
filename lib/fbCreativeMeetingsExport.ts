/**
 * Server-side export: per-(project, campaign, ad) and per-(project, audience)
 * CRM meetings (scheduled/held) for the current month, written to the
 * `fb-creative-meetings` + `fb-audience-meetings` tabs of the creative
 * workbook (SHEET_ID_CREATIVES). The Apps Script report joins these onto its
 * FB creative cards + Ad-Sets strip (option B: the warehouse key stays in the
 * Hub; the report only reads Sheets).
 *
 * This is the production path, invoked by the Cloud Scheduler cron route
 * (/api/cron/fb-creative-meetings). The standalone dev runner
 * scripts/export-fb-creative-meetings.mjs mirrors this logic for manual runs.
 */
import {
  supabaseRowsAll,
  supabaseConfigured,
  orPrefixFilter,
} from "./supabase";
import { sheetsClient, driveFolderOwner } from "@/lib/sa";
import { normAdName } from "./fbCreatives";
import { getGoogleCampaignNames } from "./googleCampaignNames";
import { getSalesforceCreativeMeetings } from "./crmData";
import {
  assignOwnerLeads,
  bmbyEventHeld,
  datedDay,
  dayInWindow,
  ilDayJerusalem,
  indexLeadsByClient,
  sehelLeadEntryHeld,
  type DayWindow,
  type OwnerAssignment,
} from "./meetingBasis";

const SHEET_ID_CREATIVES =
  process.env.SHEET_ID_CREATIVES || "1q-WFtFLDnltznwYKax2yZ1O-q_VToULWN8-sn-8xXuA";
const TAB = "fb-creative-meetings";
const AUD_TAB = "fb-audience-meetings";
const KW_TAB = "google-keyword-meetings";
/** Google meetings per CAMPAIGN. Sibling of KW_TAB — the keyword drill has
 *  existed for a while, but the Google Ads cards are grouped by campaign and
 *  had no meeting join at all. */
const GC_TAB = "google-campaign-meetings";

// Strip invisible bidi/zero-width marks (Meta injects U+200E etc. into the
// UTM values) before collapsing whitespace — same rationale as normAdName.
const clean = (s: unknown) =>
  String(s ?? "").replace(/[​-‏‪-‮⁦-⁩⁠­﻿]/g, "").replace(/\s+/g, " ").trim();

function currentMonthIL(): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  return `${p.find((x) => x.type === "year")!.value}-${p.find((x) => x.type === "month")!.value}`;
}

type LeadRow = {
  client_id: string | null;
  /** The owner-lead rule's same-day tie-break (lib/meetingBasis): two leads
   *  of one client created on the booking day → the higher lead_id owns. */
  lead_id: number | string | null;
  channel_key: string | null;
  lead_created_at: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
};
type MeetingRow = {
  client_id: string | null;
  appointment_outcome: string | null;
  meeting_date: string | null;
  appointment_date: string | null;
};

/*
 * THE BASIS PREFIX IS INVERTED IN THIS LAYER. Read this before renaming
 * anything.
 *
 * Everywhere else in the report payload an unprefixed meeting field is
 * LEAD-ENTRY and a `dated*` one is MEETING-DATE (lib/meetingBasis). Here the
 * unprefixed `scheduled`/`held` stay MEETING-DATE, because these exact rows
 * go over the wire at /api/fb-creative-meetings. The legacy Apps Script
 * report reads that JSON (Code.js:3119) and the cron's Sheet tabs mirror it,
 * so it has to stay byte-identical. The lead-entry pair rides alongside as
 * `leadScheduled`/`leadHeld`, getProjectMeetingsLiveMulti strips it (and
 * `untagged`) before the JSON is built, and lib/reportCreatives renames
 * both pairs into the payload convention on the way in.
 *
 * Salesforce is the exception inside the exception. It has no meeting
 * events, only a status snapshot of leads created in the bucket, and that
 * IS lead-entry. Its rows carry the same numbers in both slots, and the
 * caller learns from `source: "salesforce"` that the unprefixed pair is
 * not a dated count.
 */
export type CreativeMeeting = { campaign: string; ad: string; leads: number; scheduled: number; held: number };
export type AudienceMeeting = { audience: string; leads: number; scheduled: number; held: number };
export type KeywordMeeting = { keyword: string; leads: number; scheduled: number; held: number };
/** Keyed by campaign NAME, already resolved from the numeric utm_campaign —
 *  see lib/googleCampaignNames. */
export type CampaignMeeting = { campaign: string; leads: number; scheduled: number; held: number };
/** The legacy wire shape — what /api/fb-creative-meetings serves and the
 *  cron writes. Dated only. */
export type ProjectMeetings = {
  creative: CreativeMeeting[];
  audience: AudienceMeeting[];
  keyword: KeywordMeeting[];
  campaign: CampaignMeeting[];
};

/** A legacy row plus its LEAD-ENTRY pair (see the block above). */
export type WithLeadEntry<T> = T & { leadScheduled: number; leadHeld: number };

/**
 * Meetings no group row could take because the fb / gs lead they are
 * credited to carried no usable UTM: empty, a numeric id, or an unexpanded
 * placeholder. Same prefix inversion as the rows: `scheduled`/`held` are
 * dated (credited to the client's FIRST lead), `lead*` are lead-entry
 * (credited to the OWNER lead).
 *
 * Measured against the AUDIENCE dimension for fb and the KEYWORD dimension
 * for gs, because those are the two whose sums are meant to close on a
 * ערוצים row. Σ audiences + fb = the facebook row, Σ keywords + gs = the
 * google-search row. The creative dimension can drop a lead the audience
 * dimension kept (utm_content missing, utm_term present), so Σ creatives +
 * fb may still sit below the facebook row.
 */
export type UntaggedMeetings = Record<
  "fb" | "gs",
  { scheduled: number; held: number; leadScheduled: number; leadHeld: number }
>;

/** What the report reads: both bases per row, plus the untagged remainder.
 *  `untagged` is absent on Salesforce, which has no owner-lead notion. */
export type ProjectMeetingsBoth = {
  creative: WithLeadEntry<CreativeMeeting>[];
  audience: WithLeadEntry<AudienceMeeting>[];
  keyword: WithLeadEntry<KeywordMeeting>[];
  campaign: WithLeadEntry<CampaignMeeting>[];
  untagged?: UntaggedMeetings;
};

/** Which reader produced a live result. `null` = the name resolved in no
 *  CRM source, so every bucket is empty on both bases. */
export type MeetingsSource = "bmby" | "sehel" | "salesforce" | null;

/** An arbitrary [from, toExcl) slice of the project's history, tagged with a
 *  caller-chosen key. `key` is opaque here: the report uses the bare month for
 *  its (edge-clipped) window buckets and an `h:`-prefixed month for the
 *  whole-month history buckets, so both families ride ONE fetch without
 *  colliding in the caller's lookup map. */
export type MeetingsWindow = { key: string; from: string; toExcl: string };

/** Resolve a month "YYYY-MM" → [from, toExcl) in the warehouse date space. */
export function monthWindow(mon: string): { from: string; toExcl: string } {
  const from = `${mon}-01`;
  const [y, m] = mon.split("-").map(Number);
  const toExcl =
    m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return { from, toExcl };
}

/**
 * The per-project warehouse join, as PURE COMPUTE (no Sheet I/O). One pass
 * produces BOTH bases for every group (campaign|ad, audience, keyword,
 * Google campaign):
 *
 *   • leads     = distinct clients with a lead CREATED in the window (its
 *     Israel day, ilDayJerusalem), grouped by that lead's own UTM tag. No
 *     basis; it is the same number under both.
 *
 *   • scheduled / held — MEETING-DATE (the legacy wire pair). Meeting EVENTS
 *     dated in the window (appointment_date, falling back to meeting_date),
 *     credited to the group of the client's FIRST lead by lead_id, whatever
 *     that lead's age. Same event-in-window definition as the Hub funnel
 *     KPIs (owner-verified on רמת אפעל) and BMBY's period reports (3-tenant
 *     sweep 2026-07-09; see lib/crmData buildFbBreakdown). held = BMBY-
 *     confirmed only, with no past-due-unmarked estimates (owner decision
 *     2026-07-09).
 *
 *   • leadScheduled / leadHeld — LEAD-ENTRY, the OWNER-LEAD rule
 *     (lib/meetingBasis assignOwnerLeads). Every event belongs to the
 *     client's most recent lead created on or before its booking day. It
 *     counts in the window that lead was created in, credited to THAT lead's
 *     own UTM, and it counts whatever the event's own date is. This is what
 *     ALL CLIENTS "לפי כניסת ליד" counts.
 *
 * Why lead-entry cannot reuse the first-touch attribution: the trigger case
 * (The 57, September, keyword "גיא ודורון לוי מתחם האלף"). One client, one
 * google-search lead on 2026-08-25, four events. The dated join showed 3
 * תיאומים · 1 ביצוע on the keyword while the ערוצים google-search row
 * (ALL CLIENTS) showed 0 · 0. Under the owner rule all four events belong to
 * August (4/1) and September is 0/0, matching the row. The same rule also
 * closes The 57's facebook row: the audiences sum to 5/3, plus 2/1 from fb
 * owner leads with no utm_term, for 7/4 = ALL CLIENTS. The first-touch dated
 * sum over the same audiences was 21/7.
 *
 * Buckets stay additive on both bases. A dated event falls in one bucket by
 * its date, and a lead-entry event in one bucket by its owner's creation
 * day. So the report's edge-clipped window buckets, its `h:` whole months
 * and its `pre` span can all ride one fetch (see getProjectMeetingsLiveWindows).
 */
type LeadGroups = {
  ch: "fb" | "gs" | "";
  /** fb: campaign + normAdName(utm_content), both usable. */
  cre: { camp: string; ad: string } | null;
  /** fb: utm_term (the ad set / audience). "" = unusable. */
  aud: string;
  /** gs: utm_term (the keyword). "" = unusable. */
  kw: string;
  /** gs: the campaign NAME resolved from utm_campaign. "" = unresolvable. */
  gc: string;
};

const NO_GROUPS: LeadGroups = { ch: "", cre: null, aud: "", kw: "", gc: "" };

/** One lead's group keys on every join dimension, with the usability filters
 *  applied once. Numeric Meta/Google ids cannot join the name-keyed card rows,
 *  so they read as unusable, exactly as the per-dimension checks did inline
 *  before. */
function fbGroups(utmCampaign: unknown, utmContent: string | null, utmTerm: unknown): LeadGroups {
  const camp = clean(utmCampaign);
  const ad = normAdName(utmContent);
  const aud = clean(utmTerm);
  return {
    ch: "fb",
    cre: camp && ad && !numericId(camp) && !numericId(ad) ? { camp, ad } : null,
    aud: aud && !numericId(aud) ? aud : "",
    kw: "",
    gc: "",
  };
}

function gsGroups(utmTerm: unknown, campaignName: string): LeadGroups {
  const kw = clean(utmTerm);
  return { ch: "gs", cre: null, aud: "", kw: kw && !numericId(kw) ? kw : "", gc: campaignName };
}

/** A BMBY lead's groups, by channel_key. Anything but fb / gs joins nothing. */
function bmbyLeadGroups(l: LeadRow, gCampNames: Record<string, string>): LeadGroups {
  const ch = String(l.channel_key ?? "");
  if (ch === "fb") return fbGroups(l.utm_campaign, l.utm_content, l.utm_term);
  if (ch === "gs") return gsGroups(l.utm_term, gCampName(l.utm_campaign, gCampNames));
  return NO_GROUPS;
}

/** Memoised per lead ROW object. The same row objects appear in the window
 *  slices, the first-touch map and the owner assignments, so each lead's
 *  UTM is cleaned once per project, not once per window × dimension. */
function groupsMemo<L>(compute: (l: L) => LeadGroups): (l: L) => LeadGroups {
  const memo = new Map<L, LeadGroups>();
  return (l) => {
    let g = memo.get(l);
    if (!g) memo.set(l, (g = compute(l)));
    return g;
  };
}

/** client → its ORIGINATING lead's groups — FIRST-TOUCH: a client is
 *  credited to fb (creative/audience) or gs (keyword) on the DATED basis ONLY
 *  when their FIRST lead (input order: by lead_id for BMBY, by registered_at
 *  for Sehel) is that channel, matching BMBY's single-source model. So a
 *  yad2-first client who also clicked an fb ad doesn't inflate fb's dated
 *  meetings. Month-independent → built once, reused. */
function buildAttr<L>(
  leads: readonly L[],
  clientOf: (l: L) => string,
  groupsOf: (l: L) => LeadGroups,
): { attr: Map<string, LeadGroups>; first: Map<string, L> } {
  const attr = new Map<string, LeadGroups>();
  const first = new Map<string, L>();
  for (const l of leads) {
    const c = clientOf(l);
    if (!c || first.has(c)) continue;
    first.set(c, l); // this client's first (originating) lead
    const g = groupsOf(l);
    if (g.ch) attr.set(c, g);
  }
  return { attr, first };
}

/**
 * A Google lead's campaign NAME from its utm_campaign.
 *
 * Google tags the numeric campaign ID, so unlike every other dimension here
 * the raw value is exactly what `numericId` filters out — it has to be
 * translated, not rejected. "" when the id is unknown to the lookup or when
 * the tag never expanded (`{campaigned}`, a typo'd ValueTrack placeholder
 * that a chunk of the portfolio carries); the caller drops those rather than
 * bucketing them somewhere plausible.
 */
function gCampName(raw: unknown, names: Record<string, string>): string {
  const v = clean(raw);
  if (!v || v.startsWith("{")) return "";
  if (names[v]) return names[v];
  // Already a name on the accounts that tag one directly.
  return numericId(v) ? "" : v;
}

const numericId = (s: string) => /^\d{8,}$/.test(s);

/**
 * One window's group rows on both bases, built in the order the legacy
 * aggregation built them. Rows are created by `lead` (window leads, in input
 * order) and then by `dated` (clients in order of their first in-window
 * event), and a Map keeps insertion order. So the wire arrays come out
 * element-for-element as they did before the lead-entry pair existed.
 * `leadEntry` runs last, and in practice it never creates a row: an owner
 * lead created in the window is itself a window lead and has already
 * ensured its groups. getProjectMeetingsLiveMulti drops any row that is
 * still leads 0 · scheduled 0, so a stray one could not reach the wire
 * either way.
 */
function joinAccumulator() {
  type Rec = {
    extra: Record<string, string>;
    clients: Set<string>;
    sched: number;
    held: number;
    lSched: number;
    lHeld: number;
  };
  const byKey = new Map<string, Rec>();
  const byAud = new Map<string, Rec>();
  const byKw = new Map<string, Rec>();
  const byGCamp = new Map<string, Rec>();
  const untagged: UntaggedMeetings = {
    fb: { scheduled: 0, held: 0, leadScheduled: 0, leadHeld: 0 },
    gs: { scheduled: 0, held: 0, leadScheduled: 0, leadHeld: 0 },
  };
  const ensure = (map: Map<string, Rec>, key: string, extra: Record<string, string>): Rec => {
    let rec = map.get(key);
    if (!rec) {
      rec = { extra, clients: new Set(), sched: 0, held: 0, lSched: 0, lHeld: 0 };
      map.set(key, rec);
    }
    return rec;
  };
  // Legacy order within a lead: creative, audience (fb) / keyword, campaign (gs).
  const recsOf = (g: LeadGroups): Rec[] => {
    const out: Rec[] = [];
    if (g.cre) out.push(ensure(byKey, g.cre.camp + "|" + g.cre.ad, { camp: g.cre.camp, ad: g.cre.ad }));
    if (g.aud) out.push(ensure(byAud, g.aud, { aud: g.aud }));
    if (g.kw) out.push(ensure(byKw, g.kw, { kw: g.kw }));
    if (g.gc) out.push(ensure(byGCamp, g.gc, { gc: g.gc }));
    return out;
  };
  /** The untagged slot a lead with these groups falls into, if any. */
  const untaggedOf = (g: LeadGroups) =>
    g.ch === "fb" && !g.aud ? untagged.fb : g.ch === "gs" && !g.kw ? untagged.gs : null;
  const pairs = <R extends Record<string, unknown>>(r: Rec, row: R) => ({
    ...row,
    leads: r.clients.size,
    scheduled: r.sched,
    held: r.held,
    leadScheduled: r.lSched,
    leadHeld: r.lHeld,
  });
  return {
    /** A lead created in the window. */
    lead(client: string, g: LeadGroups): void {
      for (const r of recsOf(g)) r.clients.add(client);
    },
    /** A client's in-window event tallies, credited to its first lead. */
    dated(g: LeadGroups, total: number, done: number): void {
      for (const r of recsOf(g)) {
        r.sched += total;
        r.held += done;
      }
      const u = untaggedOf(g);
      if (u) {
        u.scheduled += total;
        u.held += done;
      }
    },
    /** One event whose OWNER lead (or cohort lead, Sehel) is in the window. */
    leadEntry(g: LeadGroups, held: boolean): void {
      for (const r of recsOf(g)) {
        r.lSched++;
        if (held) r.lHeld++;
      }
      const u = untaggedOf(g);
      if (u) {
        u.leadScheduled++;
        if (held) u.leadHeld++;
      }
    },
    result(): ProjectMeetingsBoth {
      // Key order inside each row is part of the byte-identical wire contract:
      // the legacy fields first, in their legacy order.
      return {
        creative: [...byKey.values()].map((r) => pairs(r, { campaign: r.extra.camp, ad: r.extra.ad })),
        audience: [...byAud.values()].map((r) => pairs(r, { audience: r.extra.aud })),
        keyword: [...byKw.values()].map((r) => pairs(r, { keyword: r.extra.kw })),
        campaign: [...byGCamp.values()].map((r) => pairs(r, { campaign: r.extra.gc })),
        untagged,
      };
    },
  };
}

/** Pure aggregation (no I/O) for ONE window of a BMBY project: window leads
 *  (distinct clients per group), dated events credited first-touch, and
 *  owner-lead events. `owners` is assignOwnerLeads over the project's FULL
 *  lead + event history, built once per project by the caller. */
function aggregateMeetings(
  winLeads: readonly LeadRow[],
  attr: ReadonlyMap<string, LeadGroups>,
  jm: readonly MeetingRow[],
  owners: readonly OwnerAssignment<LeadRow, MeetingRow>[],
  groupsOf: (l: LeadRow) => LeadGroups,
  w: DayWindow,
): ProjectMeetingsBoth {
  // Per-client tallies of meeting events dated IN the window. held = BMBY-
  // confirmed only (no past-due in_process — owner decision 2026-07-09; see
  // lib/crmData buildFbBreakdown).
  const evByClient = new Map<string, { total: number; done: number }>();
  for (const m of jm) {
    const c = String(m.client_id ?? "");
    if (!c || !dayInWindow(datedDay(m), w)) continue;
    const rec = evByClient.get(c) || { total: 0, done: 0 };
    rec.total++;
    if (bmbyEventHeld(m)) rec.done++;
    evByClient.set(c, rec);
  }

  const acc = joinAccumulator();
  // leads — created in the window, distinct client per group.
  for (const l of winLeads) {
    const c = String(l.client_id ?? "");
    if (c) acc.lead(c, groupsOf(l));
  }
  // Dated — each client's in-window event tallies, credited once per
  // dimension to the group of their FIRST-touch lead.
  for (const [c, ev] of evByClient) {
    const g = attr.get(c);
    if (g) acc.dated(g, ev.total, ev.done);
  }
  // Lead-entry — every event whose OWNER lead was created in the window,
  // credited to the owner's own UTM. Every outcome counts in תיאומים
  // (cancelled and in-process included, as ALL CLIENTS' תיאום וביטול does);
  // ביצועים = outcome "held".
  for (const a of owners) {
    if (!a.owner || !dayInWindow(a.ownerDay, w)) continue;
    acc.leadEntry(groupsOf(a.owner), bmbyEventHeld(a.event));
  }
  return acc.result();
}

/** A project's FULL lead history (utm + creation date + lead_id). Serves the
 *  first-touch map, the owner-lead index AND the per-window leads count
 *  (filtered in memory), so a multi-window read needs one leads fetch. */
function fetchAllLeads(projectId: number): Promise<LeadRow[]> {
  return supabaseRowsAll<LeadRow>(
    `v_bmby_leads_bucketed?project_id=eq.${projectId}` +
      `&select=client_id,lead_id,channel_key,lead_created_at,utm_campaign,utm_content,utm_term&order=lead_id.asc`,
  );
}

/** A project's full journey-meeting history WITH dates (to window per month). */
function fetchMeetings(projectName: string) {
  return supabaseRowsAll<MeetingRow>(
    `v_bmby_journey_meetings?project_he=eq.${encodeURIComponent(projectName)}` +
      `&select=client_id,appointment_outcome,meeting_date,appointment_date&order=meeting_id.asc`,
  );
}

/**
 * Everything window-independent about a BMBY project, built ONCE: the
 * first-touch map (dated), the owner assignment of every event (lead-entry),
 * and a per-window aggregator over both.
 *
 * Owner assignment reads the FULL lead history on purpose. An August lead
 * owns the events booked in September, so a windowed slice of leads would
 * hand those events to the fallback owner instead.
 */
function bmbyProjectJoin(
  allLeads: LeadRow[],
  jm: MeetingRow[],
  gCampNames: Record<string, string>,
): (w: DayWindow) => ProjectMeetingsBoth {
  const groupsOf = groupsMemo((l: LeadRow) => bmbyLeadGroups(l, gCampNames));
  const { attr } = buildAttr(allLeads, (l) => String(l.client_id ?? ""), groupsOf);
  const { assignments } = assignOwnerLeads(indexLeadsByClient(allLeads), jm);
  const leadDays = allLeads.map((l) => ilDayJerusalem(l.lead_created_at));
  return (w) =>
    aggregateMeetings(
      allLeads.filter((_, i) => dayInWindow(leadDays[i], w)),
      attr,
      jm,
      assignments,
      groupsOf,
      w,
    );
}

export async function computeProjectMeetings(
  projectName: string,
  projectId: number,
  from: string,
  toExcl: string,
): Promise<ProjectMeetings> {
  const [allLeads, jm, gCampNames] = await Promise.all([
    fetchAllLeads(projectId),
    fetchMeetings(projectName),
    getGoogleCampaignNames().catch(() => ({}) as Record<string, string>),
  ]);
  if (!allLeads.length)
    return { creative: [], audience: [], keyword: [], campaign: [] };
  // The cron's Sheet tabs are the same legacy contract as the endpoint.
  return toWire(bmbyProjectJoin(allLeads, jm, gCampNames)({ from, toExcl }));
}

/* ── Sehel warehouse variant ──────────────────────────────────────────
 * The Sehel tables (sehel_leads_daily / sehel_meetings) have no channel_key
 * or project_id: channel is derived from utm_source, and the project is
 * matched by name PREFIX (a Sehel project_name carries a "<account>
 * <salesperson>" suffix). Dated held = status_id 10. Same first-touch
 * attribution + camp|ad / audience / keyword keys as the BMBY path, so the
 * result joins onto the identical creative cards. Sparse by nature: only
 * utm-tagged leads attribute, and most Sehel leads carry no UTM.
 *
 * LEAD-ENTRY is the REGISTRATION COHORT. A client belongs to the window its
 * registration's Israel day falls in, and ALL of its meeting events count
 * there (any date, any status, cancelled included), credited to its UTM.
 * ביצועים = status exactly "הלקוח הגיע לפגישה" (owner decision D2,
 * sehelLeadEntryHeld). Measured 2026-09-16 against the GinotCRM push for
 * 09-01..16: cohort 8 תיאומים, exact on every ALL CLIENTS row (גוגל 2,
 * פייסבוק 4, פניה טלפונית 2). The keywords sum to גוגל and the audiences to
 * פייסבוק, with no untagged remainder. sehel_leads_daily holds ONE row per
 * client on every Sehel account (0 multi-row clients over 12,692 rows), so
 * "the client's registration" and "its lead row" are the same thing. The
 * first row by registered_at is used in case that ever changes.
 *
 * DAYS. The timestamps are TRUE UTC, not wall-clock. An older comment here
 * said "+00:00 wall-clock, plain date slice". Measured 2026-09-16: meetings
 * start 05–17 UTC with a 07 peak, i.e. 08–20 Israel with a 10:00 peak.
 * Also, the only 2 of 1,170 meetings outside that band sit at exactly 21:00
 * UTC, which is Israeli midnight. Registrations say the same: the hour
 * profile of 12,692 Sehel registered_at values has the shape of 46,501 BMBY
 * lead_created_at values (true UTC) hour for hour — trough 00–02, peak
 * 07–09, 21–24 at 3.7% vs 4.6%. A wall-clock column would sit 2–3 hours
 * earlier. So:
 *   • registered_at (leads, cohort) → ilDayJerusalem. 69 of 1,952
 *     registrations since 2026-08-01 fall at 21:00–24:00 UTC, which is
 *     the next Israel day.
 *   • starts_at (dated) keeps the UTC slice. Every other dated Sehel reader
 *     (lib/datedChannelMeetings, lib/crmData) bounds starts_at on UTC days,
 *     and the dated joins must stay on the ערוצים dated column's clock. The
 *     two rules differ only on those 2 midnight meetings.
 */
const isSehelFb = (s: unknown): boolean => {
  const v = String(s ?? "").toLowerCase().trim();
  return (
    v === "fb" || v === "an" || v === "meta" ||
    v.startsWith("facebook") || v === "ig" || v.startsWith("instagram")
  );
};
const isSehelGoogle = (s: unknown): boolean => {
  const v = String(s ?? "").toLowerCase().trim();
  return v.startsWith("goo") || v.startsWith("google");
};
/** A meeting's DATED day — see DAYS above for why this one stays UTC. */
const sehelMeetingDay = (ts: string | null | undefined) => String(ts ?? "").slice(0, 10);

type SehelLeadRow = {
  client_uuid: string | null;
  project_name: string | null;
  utm_source: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  registered_at: string | null;
};
type SehelMeetRow = {
  client_uuid: string | null;
  project_name: string | null;
  status_id: number | null;
  /** Lead-entry held test (D2). The dated side keeps status_id 10 — the two
   *  were paired 1:1 in all 1,272 meetings since 2026-01 (lib/meetingBasis). */
  status_label: string | null;
  starts_at: string | null;
};

/** Google campaign meetings are BMBY-only; Sehel's google leads join on the
 *  keyword alone (see the `campaign: []` note below). */
function sehelLeadGroups(l: SehelLeadRow): LeadGroups {
  if (isSehelFb(l.utm_source)) return fbGroups(l.utm_campaign, l.utm_content, l.utm_term);
  if (isSehelGoogle(l.utm_source)) return gsGroups(l.utm_term, "");
  return NO_GROUPS;
}

/** Multi-window Sehel per-creative attribution. Fetches the project's full
 *  lead + meeting history ONCE, then slices each window in memory (mirrors the
 *  BMBY multi-window path). Matches the project by name prefix off `crmName`. */
async function computeSehelMeetingsWindows(
  crmName: string,
  wins: MeetingsWindow[],
): Promise<Array<{ key: string } & ProjectMeetingsBoth>> {
  const empty = () =>
    wins.map((w) => ({ key: w.key, creative: [], audience: [], keyword: [], campaign: [] }));
  const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const cands = [crmName, ...crmName.split(",").map((s) => s.trim())].filter(
    (v, i, a) => v && a.indexOf(v) === i,
  );
  if (!cands.length) return empty();
  const orLike = orPrefixFilter("project_name", cands, "like");
  const targets = cands.map(norm);
  const matches = (p: string | null): boolean => {
    const n = norm(p);
    return targets.some((t) => n.startsWith(t) && (n === t || n[t.length] === " "));
  };
  const [leadsRaw, meetsRaw] = await Promise.all([
    supabaseRowsAll<SehelLeadRow>(
      `sehel_leads_daily?or=(${orLike})` +
        `&select=client_uuid,project_name,utm_source,utm_campaign,utm_content,utm_term,registered_at` +
        `&order=registered_at.asc`,
    ),
    supabaseRowsAll<SehelMeetRow>(
      `sehel_meetings?or=(${orLike})` +
        `&select=client_uuid,project_name,status_id,status_label,starts_at&order=event_uid.asc`,
    ),
  ]);
  const leads = leadsRaw.filter((l) => matches(l.project_name));
  const meets = meetsRaw.filter((m) => matches(m.project_name));
  // No leads → nothing to attribute. No meetings AT ALL for the project →
  // the sehel_meetings sync gap (see SEHEL_MEETINGS_SYNC_GAP.md): showing
  // leads·0·0 on the cards would falsely imply the creatives drove no
  // meetings. Bail so the cards fall back to ad-metrics-only, matching the
  // funnel routing guard (which keeps such projects on the Sheet).
  if (!leads.length || !meets.length) return empty();

  const clientOf = (l: SehelLeadRow) => String(l.client_uuid ?? "");
  const groupsOf = groupsMemo(sehelLeadGroups);
  // First-touch attribution (first lead per client by registered_at) for the
  // dated side; the same first row is the client's registration for the cohort.
  const { attr, first } = buildAttr(leads, clientOf, groupsOf);
  const leadDays = leads.map((l) => ilDayJerusalem(l.registered_at));
  const cohortDay = new Map<string, string>();
  for (const [c, l] of first) cohortDay.set(c, ilDayJerusalem(l.registered_at));

  return wins.map((w) => {
    // Per-client meeting-event tallies dated in the window; held = status_id 10.
    const evByClient = new Map<string, { total: number; done: number }>();
    for (const m of meets) {
      const c = String(m.client_uuid ?? "");
      if (!c || !dayInWindow(sehelMeetingDay(m.starts_at), w)) continue;
      const rec = evByClient.get(c) || { total: 0, done: 0 };
      rec.total++;
      if (Number(m.status_id) === 10) rec.done++;
      evByClient.set(c, rec);
    }
    const acc = joinAccumulator();
    // leads registered in the window, distinct client per group.
    leads.forEach((l, i) => {
      const c = clientOf(l);
      if (c && dayInWindow(leadDays[i], w)) acc.lead(c, groupsOf(l));
    });
    // Dated — credited once per dimension to the first-touch group.
    for (const [c, ev] of evByClient) {
      const g = attr.get(c);
      if (g) acc.dated(g, ev.total, ev.done);
    }
    // Lead-entry — every meeting of a client REGISTERED in the window.
    for (const m of meets) {
      const c = String(m.client_uuid ?? "");
      const l = c ? first.get(c) : undefined;
      if (!l || !dayInWindow(cohortDay.get(c) ?? "", w)) continue;
      acc.leadEntry(groupsOf(l), sehelLeadEntryHeld(m.status_label));
    }
    return {
      key: w.key,
      ...acc.result(),
      // Google campaign meetings are BMBY-only. The bridge is the numeric
      // utm_campaign → name lookup, and only BMBY's leads carry an id worth
      // resolving in volume; Sehel's Google UTM coverage is a rounding error
      // (69 tagged google leads portfolio-wide) and Salesforce's capture
      // sheet tags the campaign NAME on a different dimension. Empty rather
      // than half-populated, so a blank column reads as "not available here".
      // (sehelLeadGroups never sets `gc`, so this is already [] — kept
      // explicit so the rule is stated where the row is built.)
      campaign: [],
    };
  });
}

/**
 * Live per-project read for the report endpoint: resolve the warehouse
 * project_id by (exact) name, then compute one month's meetings. Returns
 * empty arrays (projectId:null) when the name doesn't resolve, so the caller
 * degrades gracefully to no CRM row. Thin wrapper over the multi-month path.
 */
export async function getProjectMeetingsLive(
  projectName: string,
  month?: string,
): Promise<{ month: string; project: string; projectId: number | null } & ProjectMeetings> {
  const mon = month || currentMonthIL();
  const { project, projectId, results } = await getProjectMeetingsLiveMulti(projectName, [mon]);
  const r = results[0] || { month: mon, creative: [], audience: [], keyword: [], campaign: [] };
  return {
    month: r.month,
    project,
    projectId,
    creative: r.creative,
    audience: r.audience,
    keyword: r.keyword,
    campaign: r.campaign ?? [],
  };
}

/**
 * One window as the legacy wire carries it (/api/fb-creative-meetings and
 * the cron's Sheet tabs): exactly the dated fields, in their original key
 * order, rebuilt field by field rather than spread. The live rows also carry
 * the lead-entry pair and `untagged` (see "THE BASIS PREFIX IS INVERTED"),
 * and the legacy report knows none of them.
 *
 * A row that exists only because of the lead-entry pair (leads 0 ·
 * scheduled 0) never existed before and is dropped. Every legacy row had a
 * window lead (leads ≥ 1) or a dated event (scheduled ≥ 1).
 */
const onWire = (r: { leads: number; scheduled: number }) => r.leads > 0 || r.scheduled > 0;

function toWire(r: ProjectMeetingsBoth): ProjectMeetings {
  return {
    creative: r.creative.filter(onWire).map(({ campaign, ad, leads, scheduled, held }) => ({ campaign, ad, leads, scheduled, held })),
    audience: r.audience.filter(onWire).map(({ audience, leads, scheduled, held }) => ({ audience, leads, scheduled, held })),
    keyword: r.keyword.filter(onWire).map(({ keyword, leads, scheduled, held }) => ({ keyword, leads, scheduled, held })),
    campaign: r.campaign.filter(onWire).map(({ campaign, leads, scheduled, held }) => ({ campaign, leads, scheduled, held })),
  };
}

/**
 * Live MULTI-month read for the report endpoint. The report calls this once per
 * render with every month in its window. Resolves the project + fetches the FULL
 * lead history AND meeting history ONCE (both month-independent), then slices
 * each month's cohort + in-window meetings IN MEMORY — so the whole window is
 * ~2 round-trips deep regardless of month count (was one leads query per month).
 */
export async function getProjectMeetingsLiveMulti(
  projectName: string,
  months: string[],
): Promise<{ project: string; projectId: number | null; results: Array<{ month: string } & ProjectMeetings> }> {
  const mons = months.length ? months : [currentMonthIL()];
  const { project, projectId, results } = await getProjectMeetingsLiveWindows(
    projectName,
    mons.map((m) => ({ key: m, ...monthWindow(m) })),
  );
  // Re-key to `month`. The /api/fb-creative-meetings response shape is a live
  // contract (the legacy Apps Script report reads it, Code.js:3119) and the
  // cron's month-merged Sheet tabs depend on it — drop `key` so the JSON that
  // goes over the wire is byte-identical to before. toWire strips everything
  // the page-level meeting switch added. Verified 2026-09-16 byte-for-byte
  // against the pre-change module: 8 responses over The 57, mia, Ginot and
  // Shbn-holon, current and winter months.
  return {
    project,
    projectId,
    results: results.map((r) => ({ month: r.key, ...toWire(r) })),
  };
}

/**
 * Split windows into runs whose members do not overlap, keeping each
 * window's original position. The report's windows overlap by design (the
 * edge-clipped window months, the `h:` whole months that contain them, and
 * `pre`), so the report's request becomes three runs.
 */
function nonOverlappingRuns(wins: readonly MeetingsWindow[]): { w: MeetingsWindow; at: number }[][] {
  const runs: { w: MeetingsWindow; at: number }[][] = [];
  wins.forEach((w, at) => {
    const run = runs.find((r) => r.every(({ w: x }) => w.toExcl <= x.from || w.from >= x.toExcl));
    if (run) run.push({ w, at });
    else runs.push([{ w, at }]);
  });
  return runs;
}

/**
 * Live per-project read over ARBITRARY [from, toExcl) windows — the generalized
 * form of the multi-month path above.
 *
 * The month bucketing this replaces was always a SLICING choice, never a fetch
 * constraint: the project's lead history and meeting history are both fetched
 * whole and are window-independent (fetchAllLeads / fetchMeetings carry no date
 * predicate), and attribution is built once over all of it. So N windows cost
 * the same ~2 round-trips as 1, whatever their bounds.
 *
 * The report uses that to fix a real skew: it passes month buckets whose FIRST
 * and LAST are narrowed to the report window's own edges, so scheduled/held
 * span exactly what cost/leads span (see windowBuckets in lib/reportCreatives).
 *
 * `source` names the reader that answered; the report derives which bases the
 * joins exist on from it (Salesforce: lead-entry only).
 */
export async function getProjectMeetingsLiveWindows(
  projectName: string,
  windows: MeetingsWindow[],
): Promise<{
  project: string;
  projectId: number | null;
  source: MeetingsSource;
  results: Array<{ key: string } & ProjectMeetingsBoth>;
}> {
  if (!supabaseConfigured()) throw new Error("Supabase not configured");
  const cur = currentMonthIL();
  const wins = windows.length ? windows : [{ key: cur, ...monthWindow(cur) }];
  const found = await supabaseRowsAll<{ project_id: number; project_name: string }>(
    `v_report_v2_bmby_projects?select=project_id,project_name&project_name=eq.${encodeURIComponent(projectName)}&limit=1`,
  );
  if (!found.length) {
    // Not a BMBY project — try the Sehel warehouse. Kept INDEPENDENT of the
    // SUPABASE_SEHEL_WAREHOUSE funnel flag on purpose: these creative cards are
    // internal-only and purely additive (they attach leads·scheduled·held to an
    // existing card), so they don't need — and shouldn't wait on — the funnel
    // supersede that flag also gates. Only claim Sehel results when the join
    // actually produced attribution, so a genuine no-match (Salesforce / not in
    // any warehouse) still degrades to no CRM row on the cards.
    try {
      const results = await computeSehelMeetingsWindows(projectName, wins);
      if (results.some((r) => r.creative.length || r.audience.length || r.keyword.length))
        return { project: projectName, projectId: null, source: "sehel", results };
    } catch {
      /* fall through */
    }
    // Salesforce (Sheet-based, status snapshot — a lead's own מצב ליד is its
    // scheduled/held; UTM joined from the capture sheet by phone→email). Last
    // fallback: a project in NEITHER warehouse. Same claim-only-if-it-attributed
    // rule, so a genuine no-match still renders the cards with no CRM row.
    //
    // ONE CALL PER NON-OVERLAPPING RUN. getSalesforceCreativeMeetings gives
    // each lead to the FIRST window containing it, which is right for the
    // disjoint months the legacy endpoint passes and wrong for the report,
    // whose `h:` history months contain its window months. Every lead
    // created in the window was claimed by the window bucket, so the card
    // hover's history row for the report's own month(s) always read 0 on
    // Salesforce. Runs are in-memory passes over a tab that is cache()d per
    // request, so they cost no extra Sheet reads.
    try {
      const out = new Array<{ key: string } & ProjectMeetingsBoth>(wins.length);
      for (const run of nonOverlappingRuns(wins)) {
        const sf = await getSalesforceCreativeMeetings(projectName, run.map((x) => x.w));
        sf.forEach((r, i) => {
          // A snapshot of leads created in the bucket IS lead-entry: the same
          // pair fills both slots (see "THE BASIS PREFIX IS INVERTED").
          const both = <T extends { scheduled: number; held: number }>(row: T) => ({
            ...row,
            leadScheduled: row.scheduled,
            leadHeld: row.held,
          });
          out[run[i].at] = {
            key: r.key,
            creative: r.creative.map(both),
            audience: r.audience.map(both),
            keyword: r.keyword.map(both),
            // See the note in the Sehel branch: no Google campaign dimension here.
            campaign: [],
          };
        });
      }
      if (out.some((r) => r && (r.creative.length || r.audience.length || r.keyword.length)))
        return {
          project: projectName,
          projectId: null,
          source: "salesforce",
          results: out.map(
            (r, i) => r ?? { key: wins[i].key, creative: [], audience: [], keyword: [], campaign: [] },
          ),
        };
    } catch {
      /* fall through to empty */
    }
    return {
      project: projectName,
      projectId: null,
      source: null,
      results: wins.map((w) => ({
        key: w.key,
        creative: [],
        audience: [],
        keyword: [],
        campaign: [],
      })),
    };
  }
  const projectId = found[0].project_id;
  const projName = found[0].project_name;
  // Lead history + meeting history are both month-independent — fetch once,
  // slice per window in memory.
  const [allLeads, jm, gCampNames] = await Promise.all([
    fetchAllLeads(projectId),
    fetchMeetings(projName),
    getGoogleCampaignNames().catch(() => ({}) as Record<string, string>),
  ]);
  const perWindow = bmbyProjectJoin(allLeads, jm, gCampNames);
  const results = wins.map((w) => ({ key: w.key, ...perWindow(w) }));
  return { project: projName, projectId, source: "bmby", results };
}

export async function exportFbCreativeMeetings(
  month?: string,
): Promise<{
  month: string;
  creativeRows: number;
  audienceRows: number;
  keywordRows: number;
  campaignRows: number;
}> {
  if (!supabaseConfigured()) throw new Error("Supabase not configured");
  const mon = month || currentMonthIL();
  const from = `${mon}-01`;
  const [y, m] = mon.split("-").map(Number);
  const toExcl =
    m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;

  const projects = await supabaseRowsAll<{ project_id: number; project_name: string }>(
    `v_report_v2_bmby_projects?select=project_id,project_name&order=project_name`,
  );

  const creativeRows: (string | number)[][] = []; // project, campaign, ad, leads, sched, held
  const audRows: (string | number)[][] = []; // project, audience, leads, sched, held
  const kwRows: (string | number)[][] = []; // project, keyword, leads, sched, held
  const gcRows: (string | number)[][] = []; // project, campaign, leads, sched, held

  for (const p of projects) {
    const m = await computeProjectMeetings(p.project_name, p.project_id, from, toExcl);
    for (const r of m.creative) creativeRows.push([p.project_name, r.campaign, r.ad, r.leads, r.scheduled, r.held]);
    for (const r of m.audience) audRows.push([p.project_name, r.audience, r.leads, r.scheduled, r.held]);
    for (const r of m.keyword) kwRows.push([p.project_name, r.keyword, r.leads, r.scheduled, r.held]);
    for (const r of m.campaign) gcRows.push([p.project_name, r.campaign, r.leads, r.scheduled, r.held]);
  }

  // ── write both tabs ──
  const sheets = sheetsClient(driveFolderOwner());
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID_CREATIVES,
    fields: "sheets.properties(title)",
  });
  const existing = new Set((meta.data.sheets ?? []).map((s) => s.properties?.title));
  const updatedAt = new Date().toISOString();
  const writeTab = async (tab: string, header: string[], data: (string | number)[][]) => {
    if (!existing.has(tab)) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID_CREATIVES,
        requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] },
      });
    }
    // MERGE by month — the tab is per-creative/-audience meeting HISTORY now.
    // (Was clear+rewrite, which kept only the last run's month, so the report's
    // past-month views — e.g. monthOverride=2026-03 — found nothing to join.)
    // Preserve every row whose `month` ≠ this run's month; replace only `mon`.
    let preserved: (string | number)[][] = [];
    try {
      const cur = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID_CREATIVES,
        range: `'${tab}'!A:Z`,
        valueRenderOption: "UNFORMATTED_VALUE",
      });
      const vals = (cur.data.values ?? []) as (string | number)[][];
      if (vals.length > 1) {
        const exHdr = (vals[0] as unknown[]).map((h) => String(h ?? ""));
        const exMonth = exHdr.indexOf("month");
        for (let i = 1; i < vals.length; i++) {
          const row = vals[i];
          if (exMonth >= 0 && String(row[exMonth] ?? "") === mon) continue;
          // Reshape onto OUR canonical header order so a column add/reorder
          // can't misalign preserved months.
          preserved.push(
            header.map((c) => {
              const idx = exHdr.indexOf(c);
              return idx >= 0 ? ((row[idx] ?? "") as string | number) : "";
            }),
          );
        }
      }
    } catch {
      preserved = [];
    }
    const fresh = data.map((r) => [...r, mon, updatedAt]);
    const values = [header, ...preserved, ...fresh];
    await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID_CREATIVES, range: `'${tab}'!A:Z` });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID_CREATIVES,
      range: `'${tab}'!A1`,
      valueInputOption: "RAW",
      requestBody: { values },
    });
  };
  await writeTab(TAB, ["project", "campaign", "ad_name", "leads", "scheduled", "held", "month", "updated_at"], creativeRows);
  await writeTab(AUD_TAB, ["project", "audience", "leads", "scheduled", "held", "month", "updated_at"], audRows);
  await writeTab(KW_TAB, ["project", "keyword", "leads", "scheduled", "held", "month", "updated_at"], kwRows);
  await writeTab(GC_TAB, ["project", "campaign", "leads", "scheduled", "held", "month", "updated_at"], gcRows);

  return {
    month: mon,
    creativeRows: creativeRows.length,
    audienceRows: audRows.length,
    keywordRows: kwRows.length,
    campaignRows: gcRows.length,
  };
}
