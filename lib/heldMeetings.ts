import { cache } from "react";
import { orExactFilter, supabaseConfigured, supabaseRowsAll } from "@/lib/supabase";
import {
  attachEntryUtms,
  cleanSehelContent,
  numberLeadEntries,
  utmSets,
} from "@/lib/signedClients";
import { getGoogleCampaignNames } from "@/lib/googleCampaignNames";
import type { DossierClient, DossierTouch } from "@/components/report/ClientDossier";

/**
 * The meetings that actually TOOK PLACE in the report window, and the file
 * behind each one.
 *
 * The funnel already counts them. Until now that count was where the trail
 * ended: a client file could only be opened from חוזים, which lists people
 * who reached a sale stage, and almost nobody who sits in a meeting has.
 * Measured on 2026-08 across the ten busiest projects: 422 clients were met,
 * 18 of them appear in חוזים — so 96% of the month's meeting record had no
 * door, while the salesperson's notes sat in the warehouse. This is the door.
 *
 * ── Which date ──
 * `appointment_date`, when the meeting happened, NOT `meeting_date`, when it
 * was booked. Those are different populations and the gap is not small: on
 * דרימס ארנונה in August, 77 meeting rows were booked and 33 were held. The
 * held figure is what the funnel counts and what a status call is about.
 *
 * ── Two platforms, one shape ──
 * getHeldMeetings reads BMBY, getHeldMeetingsSehel reads Sehel, and both
 * return this same result so a project on either — or on both — renders one
 * section. Sehel was excluded at first on the belief that it had no
 * per-meeting outcome joined to a trail of notes; see that function for what
 * it actually has, which in places is more than BMBY. Salesforce is the one
 * genuinely out: its CRM lives in a Sheet tab with no meeting table at all.
 * The route answers it with a reason rather than an error, so the panel can
 * say why it is empty instead of implying there were no meetings.
 *
 * ── On the objections column ──
 * Both CRMs record objections against the CLIENT, not against a meeting, and
 * neither carries a timestamp that would tie one to the other. What this returns
 * is therefore "the objections on this client's record", and the UI must say
 * that rather than "what came up in the meeting" — a client met twice would
 * otherwise show the same objections on both rows as if each had produced
 * them.
 */

const MAX_MEETINGS = 400;
const MAX_TOUCHES = 60;
const clean = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();
const inList = (ids: readonly string[]) =>
  ids.map((v) => `"${v.replace(/"/g, "")}"`).join(",");

type MeetingRow = {
  meeting_id: string | null;
  client_id: string | null;
  meeting_date: string | null;
  appointment_date: string | null;
  appointment_outcome: string | null;
  held: boolean | null;
  taskedit_subject: string | null;
  meeting_user: string | null;
  meeting_seq: number | null;
  first_lid_source: string | null;
  first_lid_channel: string | null;
  last_lid_source: string | null;
  lead_age_days: number | null;
};
type DailyRow = {
  client_id: string | null;
  client_name: string | null;
  phone: string | null;
  client_status: string | null;
  pipeline: string | null;
  media_source_clean: string | null;
  salesperson: string | null;
  agent: string | null;
  objections: string | null;
  lead_created_at: string | null;
  /** The link that brought the lead. Present on this table all along and
   *  simply never selected — see the utms note in the client build below. */
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
};
type LeadRow = {
  client_id: string | null;
  name: string | null;
  phone_normalized: string | null;
  current_status: string | null;
  stage_name: string | null;
  salesperson: string | null;
  source_agg: string | null;
  deal_type: string | null;
  rooms: string | null;
  notes: string | null;
  first_touch_date: string | null;
  last_touch_date: string | null;
  touches_count: number | null;
  meetings_count: number | null;
  lids_count: number | null;
};
type TouchRow = {
  client_id: string | null;
  event_date: string | null;
  type: string | null;
  user_name: string | null;
  content: string | null;
  subject: string | null;
  is_meeting: boolean | null;
};

export type HeldMeeting = {
  meetingId: string;
  clientId: string;
  /** When it happened. */
  date: string;
  /** When it was booked — the wait is the interesting part of the pair. */
  bookedDate: string;
  /** 1 = first meeting with this client, 2 = second, … */
  seq: number;
  /** BMBY's own one-line note on the appointment. Often truncated upstream
   *  with a trailing "…" — the full text is in the journey. */
  subject: string;
  /** Can be several people; BMBY comma-joins them into one cell. */
  agents: string[];
  /** Where the lead originally came from, and where it came from last. */
  firstSource: string;
  firstChannel: string;
  lastSource: string;
  /** True when the two differ — the lead was opened by one channel and
   *  arrived at this meeting through another. */
  sourceMoved: boolean;
  /** Days from the lead arriving to this meeting, per the warehouse. */
  leadAgeDays: number | null;
  /** The salesperson's own write-up nearest this date, when there is one. */
  note: string;
  /** Sehel only — what KIND of meeting it was (פרזנטציה / פגישת המשך /
   *  חתימת הסכם / הרשמה / מו״מ). BMBY has no equivalent; it numbers
   *  meetings instead, which is what `seq` carries. */
  kind?: string;
};

export type HeldMeetingsResult = {
  meetings: HeldMeeting[];
  /** One entry per distinct client across those meetings. */
  clients: DossierClient[];
  /** Held meetings in the window (before the display cap). */
  total: number;
  /** Distinct people met. */
  clientsMet: number;
  /** How many of the meetings carry a written note. */
  withNotes: number;
};

const EMPTY: HeldMeetingsResult = {
  meetings: [],
  clients: [],
  total: 0,
  clientsMet: 0,
  withNotes: 0,
};

/**
 * Held meetings for a project's CRM account(s) inside [from, to].
 *
 * The account filter is EXACT. `project_he` holds the account name itself,
 * and one BMBY account name is a prefix of another — "באר יעקב" and
 * "באר יעקב מערב", two different developers — which is how one client's
 * signed customers ended up on another's page on 2026-09-07. Nothing here
 * may match on a prefix. Everything after this query is keyed on the
 * client_ids these rows return, so the account check happens once and
 * bounds the whole read.
 */
export const getHeldMeetings = cache(
  async (args: {
    crmAccounts: readonly string[];
    from: string;
    to: string;
  }): Promise<HeldMeetingsResult | null> => {
    const accounts = args.crmAccounts.map(clean).filter(Boolean);
    if (!supabaseConfigured() || !accounts.length) return null;
    try {
      const or = orExactFilter("project_he", accounts);
      const rows = await supabaseRowsAll<MeetingRow>(
        `v_bmby_journey_meetings?or=(${or})` +
          `&appointment_date=gte.${args.from}&appointment_date=lte.${args.to}` +
          `&select=meeting_id,client_id,meeting_date,appointment_date,` +
          `appointment_outcome,held,taskedit_subject,meeting_user,meeting_seq,` +
          `first_lid_source,first_lid_channel,last_lid_source,lead_age_days` +
          `&order=appointment_date.desc`,
        { maxRows: 5000 },
      );
      // Held filtered in memory rather than server-side: it lives in two
      // columns (`held` and `appointment_outcome`) and expressing "account
      // matches AND (either)" as nested PostgREST or=/and= is the shape that
      // silently matches nothing. The window already bounds this to tens of
      // rows per project.
      const held = rows.filter(
        (r) => r.held === true || clean(r.appointment_outcome) === "held",
      );
      if (!held.length) return EMPTY;

      const ids = [...new Set(held.map((r) => clean(r.client_id)).filter(Boolean))];
      const capped = held.slice(0, MAX_MEETINGS);

      const daily = new Map<string, DailyRow>();
      /** EVERY lead row per client, for the UTM tags only — see the note at
       *  the fill site. `daily` still holds just the newest, which is the
       *  right snapshot for status, salesperson and the rest. */
      const utmRows = new Map<string, DailyRow[]>();
      const leads = new Map<string, LeadRow>();
      const touches = new Map<string, DossierTouch[]>();
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const [dr, lr, tr] = await Promise.all([
          supabaseRowsAll<DailyRow>(
            `bmby_leads_daily?client_id=in.(${inList(chunk)})` +
              `&select=client_id,client_name,phone,client_status,pipeline,` +
              `media_source_clean,salesperson,agent,objections,lead_created_at,` +
              `utm_source,utm_medium,utm_campaign,utm_content,utm_term` +
              `&order=lead_created_at.desc`,
            { maxRows: 5000 },
          ).catch(() => [] as DailyRow[]),
          supabaseRowsAll<LeadRow>(
            `bmby_leads?client_id=in.(${inList(chunk)})` +
              `&select=client_id,name,phone_normalized,current_status,stage_name,` +
              `salesperson,source_agg,deal_type,rooms,notes,first_touch_date,` +
              `last_touch_date,touches_count,meetings_count,lids_count`,
            { maxRows: 500 },
          ).catch(() => [] as LeadRow[]),
          supabaseRowsAll<TouchRow>(
            `bmby_touches?client_id=in.(${inList(chunk)})` +
              `&select=client_id,event_date,type,user_name,content,subject,is_meeting` +
              `&order=event_date.asc`,
            { maxRows: MAX_TOUCHES * chunk.length },
          ).catch(() => [] as TouchRow[]),
        ]);
        // Newest lead row per client wins for the snapshot fields; the query
        // is already ordered, so the first one seen is the one to keep.
        //
        // The UTMs are the exception and must NOT follow that rule. A client
        // who first arrived through a tagged Google ad and later re-entered
        // by phone has two lead rows; the newest is the phone one, whose
        // utm columns are all NULL, and reading the tags off it reported
        // "הליד הגיע בלי תגיות UTM" for a lead the warehouse has fully
        // tagged. Measured: it blanks 1,389 of the 13,744 clients the
        // warehouse could answer for. So every row is kept for the tags,
        // and utmSets dedupes them into one set per distinct link.
        for (const r of dr) {
          const id = clean(r.client_id);
          if (!id) continue;
          if (!daily.has(id)) daily.set(id, r);
          (utmRows.get(id) ?? utmRows.set(id, []).get(id)!).push(r);
        }
        for (const r of lr) {
          const id = clean(r.client_id);
          if (id && !leads.has(id)) leads.set(id, r);
        }
        for (const r of tr) {
          const id = clean(r.client_id);
          if (!id) continue;
          const list = touches.get(id) ?? [];
          if (list.length >= MAX_TOUCHES) continue;
          const type = clean(r.type) || "—";
          list.push({
            date: clean(r.event_date).slice(0, 10),
            type,
            agent: clean(r.user_name),
            content: clean(r.content) || clean(r.subject),
            isMeeting: !!r.is_meeting,
            // On a LID row the subject is the arrival channel, not a subject
            // line — same reading as lib/signedClients.
            ...(type === "LID" ? { entrySource: clean(r.subject) } : {}),
          });
          touches.set(id, list);
        }
      }

      // Google writes its campaign as a numeric id; the map turns it into a
      // name. Degrades to {} so a lookup failure costs the campaign's NAME,
      // not the whole tag set.
      const campaignNames = await getGoogleCampaignNames().catch(
        () => ({}) as Record<string, string>,
      );

      const clients: DossierClient[] = ids.map((id) => {
        const d = daily.get(id);
        const l = leads.get(id);
        const journey = touches.get(id) ?? [];
        return {
          clientId: id,
          name: clean(l?.name) || clean(d?.client_name),
          phone: clean(l?.phone_normalized) || clean(d?.phone),
          status: clean(l?.current_status) || clean(d?.client_status),
          stage: clean(l?.stage_name),
          salesperson:
            clean(l?.salesperson) || clean(d?.salesperson) || clean(d?.agent),
          source: clean(l?.source_agg),
          mediaSource: clean(d?.media_source_clean),
          dealType: clean(l?.deal_type),
          rooms: clean(l?.rooms),
          notes: clean(l?.notes),
          leadCreated: clean(d?.lead_created_at).slice(0, 10),
          firstTouch: clean(l?.first_touch_date).slice(0, 10),
          lastTouch: clean(l?.last_touch_date).slice(0, 10),
          touchesCount: Number(l?.touches_count ?? journey.length) || 0,
          meetingsCount: Number(l?.meetings_count ?? 0) || 0,
          leadsCount: Number(l?.lids_count ?? 0) || 0,
          objections: clean(d?.objections),
          utms: utmSets(utmRows.get(id), campaignNames),
          // Per-ARRIVAL tags too, not only the client's whole pile: a client
          // who came in twice off two different ads gets each entry labelled
          // with the one that brought it. Same pair signedClients uses; the
          // dossier renders them under each "ליד נכנס" row in the journey.
          journey: attachEntryUtms(
            numberLeadEntries(journey),
            utmRows.get(id),
            campaignNames,
          ),
        };
      });

      /** The write-up for THIS meeting: the client's nearest meeting touch,
       *  preferring the same day. BMBY dates a touch to the day, so an exact
       *  hit is the common case; the ±3 day reach covers a desk that wrote it
       *  up the next morning. Falls back to nothing rather than showing an
       *  unrelated note from months away. */
      const noteFor = (clientId: string, on: string): string => {
        const list = (touches.get(clientId) ?? []).filter(
          (t) => t.isMeeting && t.content,
        );
        if (!list.length || !on) return "";
        const target = Date.parse(`${on}T00:00:00Z`);
        let best: DossierTouch | null = null;
        let bestGap = Infinity;
        for (const t of list) {
          const gap = Math.abs(Date.parse(`${t.date}T00:00:00Z`) - target);
          if (!Number.isFinite(gap) || gap > 3 * 86400000) continue;
          if (gap < bestGap) {
            bestGap = gap;
            best = t;
          }
        }
        return best?.content ?? "";
      };

      const meetings: HeldMeeting[] = capped.map((r) => {
        const clientId = clean(r.client_id);
        const date = clean(r.appointment_date).slice(0, 10);
        const first = clean(r.first_lid_source);
        const last = clean(r.last_lid_source);
        return {
          meetingId: clean(r.meeting_id),
          clientId,
          date,
          bookedDate: clean(r.meeting_date).slice(0, 10),
          seq: Number(r.meeting_seq ?? 1) || 1,
          subject: clean(r.taskedit_subject),
          agents: clean(r.meeting_user)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          firstSource: first,
          firstChannel: clean(r.first_lid_channel),
          lastSource: last,
          sourceMoved: !!first && !!last && first !== last,
          leadAgeDays:
            r.lead_age_days == null ? null : Number(r.lead_age_days) || 0,
          note: noteFor(clientId, date),
        };
      });

      return {
        meetings,
        clients,
        total: held.length,
        clientsMet: ids.length,
        withNotes: meetings.filter((m) => m.note).length,
      };
    } catch (e) {
      console.warn(
        `[getHeldMeetings] failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  },
);

// ── Sehel ───────────────────────────────────────────────────────────────

type SehelMeetingRow = {
  event_uid: string | null;
  client_uuid: string | null;
  client_name: string | null;
  meeting_type: string | null;
  status_label: string | null;
  starts_at: string | null;
};
type SehelLeadRow = {
  client_uuid: string | null;
  project_name: string | null;
  name: string | null;
  phone: string | null;
  stage: string | null;
  media_source_raw: string | null;
  objections: string | null;
  needs_rooms: string | null;
  registered_at: string | null;
};
type SehelTouchRow = {
  client_uuid: string | null;
  event_at: string | null;
  event_type: string | null;
  agent: string | null;
  content: string | null;
  is_meeting: boolean | null;
  source: string | null;
  is_lead_event: boolean | null;
};

/** Sehel's own word for "they turned up". The other three values are
 *  `יש אישור הגעה` (confirmed, not yet held), `הלקוח ביקש לבטל` and
 *  `לא ידוע` — none of which is evidence the meeting happened. 1,037 of
 *  1,247 rows carry this one. */
const SEHEL_HELD = "הלקוח הגיע לפגישה";

/**
 * Who to credit a Sehel meeting to.
 *
 * `sehel_meetings.agent_user_id` is empty on all 1,247 rows, and the
 * `agent` column on a MEETING touch is not a name at all — the scraper
 * puts the whole booking audit line there:
 *
 *   "נקבעה על-ידי לריסה טבעוני רזניק 16.06.26 10:17"
 *   "נקבעה על-ידי X 08.06.26 13:35בוטלה על-ידי Y 16.06.26 07:53"
 *
 * Rendering that raw put "נקבעה על-ידי" in the salesperson column, which
 * is a preposition, not a person. So two sources, in order:
 *
 *  1. The lead's ASSIGNED rep, which Sehel encodes as the suffix on
 *     `sehel_leads_daily.project_name` ("אפרידר גינות רחובות נדב כהן").
 *     That is the person who owns the client and almost always the one in
 *     the room.
 *  2. Failing that, whoever BOOKED it, pulled out of the line above.
 *     Weaker — booking and running a meeting are not the same job — but a
 *     real name beats a blank.
 *
 * Sehel records nowhere who actually SAT in the meeting; neither of these
 * claims to, and the column is titled "איש מכירות" rather than
 * "מי ניהל את הפגישה" for exactly that reason.
 */
function sehelBookedBy(rawAgent: string): string {
  const m = /נקבעה על[- ]ידי\s+(.+?)(?=\s*\d{1,2}\.\d{1,2}\.\d{2,4}|\s*בוטלה|$)/.exec(
    rawAgent,
  );
  return m ? m[1].trim() : "";
}

/**
 * Sehel wraps a meeting note in scheduling boilerplate, and it is most of
 * the column: of 876 meeting touches, 458 contain one of these clauses and
 * 458 minus the ones with real text beside them are nothing else. Counting
 * those as "written summaries" made the tile claim 8 of 8 on גינות when
 * several rows said only "יוצר הפגישה: ירון קידר" — the name of whoever
 * opened the calendar entry, which is not a record of what was discussed.
 *
 * Stripped, 418 of 876 (48%) carry a real write-up, median 153 characters,
 * and they read like "יוסי ועומר זוג מבוגרים מנס ציונה… הסתכלנו על".
 * The rate is higher among HELD meetings specifically, because most of the
 * pure-boilerplate rows belong to meetings that were booked and cancelled.
 *
 * Applied to the summary COLUMN only. The drawer keeps the full text — the
 * booking trail is part of the record, it is just not a summary.
 */
const SEHEL_BOILERPLATE = [
  /יוצר הפגישה:.*$/s,
  /משתתפים:.*$/s,
  /נקבעה על[- ]ידי.*$/s,
  /בוטלה על[- ]ידי.*$/s,
  /אושרה על[- ]ידי.*$/s,
];
function sehelNoteBody(cleaned: string): string {
  let v = cleaned;
  for (const re of SEHEL_BOILERPLATE) v = v.replace(re, "");
  return v.trim();
}

/** "משתתפים: אילן גרבר" — who was actually in the room. The one place
 *  Sehel records it, and better than any of the other candidates because
 *  it is neither the lead's owner nor whoever clicked "new meeting". */
function sehelAttendees(cleaned: string): string[] {
  const m = /משתתפים:\s*(.+?)$/s.exec(cleaned);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The salesperson suffix Sehel appends to a lead's project_name. Returns
 *  "" when the row is the bare account name (no rep encoded). */
function sehelRepSuffix(projectName: string, accounts: readonly string[]): string {
  const p = String(projectName ?? "").trim();
  for (const a of accounts) {
    if (p === a) return "";
    if (p.startsWith(`${a} `)) return p.slice(a.length + 1).trim();
  }
  return "";
}

/**
 * The Sehel half of פגישות שהתקיימו.
 *
 * Sehel was left out of the first version on the belief that it had no
 * per-meeting outcome joined to a trail of notes. That was wrong, and it
 * is the second time that same wrong belief has been recorded about this
 * warehouse — `sehel_touches` holds 132,107 rows, more than BMBY's. What
 * it actually has, checked column by column:
 *
 *   starts_at      when the meeting happened
 *   status_label   whether it did — see SEHEL_HELD
 *   meeting_type   פרזנטציה · פגישת המשך · הרשמה · חתימת הסכם · מו״מ,
 *                  which is RICHER than BMBY, where the only distinction
 *                  between meetings is their number
 *   sehel_touches  the write-up: 263 meeting touches carried text across
 *                  the 200 clients sampled, median 129 characters — twice
 *                  BMBY's 65
 *
 * Two things it does not have, and how each is answered:
 *
 *   description    empty on all 1,247 rows. Not a source; the write-up
 *                  comes from the touch.
 *   agent_user_id  empty on all 1,247 rows. The salesperson is taken from
 *                  the meeting touch's own `agent` instead, which is where
 *                  Sehel actually records who ran it.
 *
 * And one thing that is computed rather than read: BMBY numbers a
 * client's meetings (`meeting_seq`), Sehel does not, so the number is
 * derived by ordering that client's held meetings by date. Same meaning
 * in the same column.
 */
export const getHeldMeetingsSehel = cache(
  async (args: {
    crmAccounts: readonly string[];
    from: string;
    to: string;
  }): Promise<HeldMeetingsResult | null> => {
    const accounts = args.crmAccounts.map(clean).filter(Boolean);
    if (!supabaseConfigured() || !accounts.length) return null;
    try {
      // EXACT here, and that is not an oversight about the other Sehel
      // readers. `sehel_leads_daily.project_name` carries the
      // "<project> <salesperson>" suffix and genuinely needs a prefix
      // match; `sehel_meetings.project_name` does not — it holds 6
      // distinct values, none of which extends another. Matching this
      // table on a prefix would buy nothing and open the same door that
      // put one developer's customers on another's page.
      const or = orExactFilter("project_name", accounts);
      const rows = await supabaseRowsAll<SehelMeetingRow>(
        `sehel_meetings?or=(${or})` +
          `&starts_at=gte.${args.from}T00:00:00` +
          `&starts_at=lt.${args.to}T23:59:59` +
          `&select=event_uid,client_uuid,client_name,meeting_type,status_label,starts_at` +
          `&order=starts_at.desc`,
        { maxRows: 5000 },
      );
      const held = rows.filter((r) => clean(r.status_label) === SEHEL_HELD);
      if (!held.length) return EMPTY;

      const ids = [...new Set(held.map((r) => clean(r.client_uuid)).filter(Boolean))];
      const capped = held.slice(0, MAX_MEETINGS);

      const leadRows = new Map<string, SehelLeadRow[]>();
      const touches = new Map<string, DossierTouch[]>();
      const rawTouches = new Map<string, SehelTouchRow[]>();
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const [lr, tr] = await Promise.all([
          supabaseRowsAll<SehelLeadRow>(
            `sehel_leads_daily?client_uuid=in.(${inList(chunk)})` +
              `&select=client_uuid,project_name,name,phone,stage,media_source_raw,` +
              `objections,needs_rooms,registered_at&order=registered_at.desc`,
            { maxRows: 5000 },
          ).catch(() => [] as SehelLeadRow[]),
          supabaseRowsAll<SehelTouchRow>(
            `sehel_touches?client_uuid=in.(${inList(chunk)})` +
              `&select=client_uuid,event_at,event_type,agent,content,is_meeting,` +
              `source,is_lead_event&order=event_at.asc`,
            { maxRows: MAX_TOUCHES * chunk.length },
          ).catch(() => [] as SehelTouchRow[]),
        ]);
        for (const r of lr) {
          const id = clean(r.client_uuid);
          if (!id) continue;
          leadRows.set(id, [...(leadRows.get(id) ?? []), r]);
        }
        for (const r of tr) {
          const id = clean(r.client_uuid);
          if (!id) continue;
          rawTouches.set(id, [...(rawTouches.get(id) ?? []), r]);
          const list = touches.get(id) ?? [];
          if (list.length >= MAX_TOUCHES) continue;
          const type = clean(r.event_type) || "—";
          const agent = clean(r.agent);
          list.push({
            date: clean(r.event_at).slice(0, 10),
            type,
            agent,
            // Sehel mashes time, date, type, text and agent into one
            // string — the same cleaner the חוזים reader uses.
            content: cleanSehelContent(r.content, type, agent),
            isMeeting: !!r.is_meeting,
            ...(r.is_lead_event ? { entrySource: clean(r.source) } : {}),
          });
          touches.set(id, list);
        }
      }

      /** A client can hold lead rows in several projects. Prefer one that
       *  belongs to an account we are actually reading, so `stage` and
       *  `media_source_raw` describe THIS project rather than whichever
       *  row happened to be newest. Prefix, because the leads table is the
       *  one that carries the salesperson suffix. */
      const leadFor = (id: string): SehelLeadRow | undefined => {
        const list = leadRows.get(id) ?? [];
        const mine = list.find((r) => {
          const p = clean(r.project_name);
          return accounts.some((a) => p === a || p.startsWith(`${a} `));
        });
        return mine ?? list[0];
      };

      const clients: DossierClient[] = ids.map((id) => {
        const l = leadFor(id);
        const journey = touches.get(id) ?? [];
        const raws = rawTouches.get(id) ?? [];
        const fallbackName = clean(
          held.find((m) => clean(m.client_uuid) === id)?.client_name,
        );
        return {
          clientId: id,
          name: clean(l?.name) || fallbackName,
          phone: clean(l?.phone),
          status: clean(l?.stage),
          stage: clean(l?.stage),
          salesperson:
            sehelRepSuffix(clean(l?.project_name), accounts) ||
            // A non-meeting touch DOES carry a plain name; only meeting
            // rows hold the booking line. Prefer one of those, and strip
            // the phone number Sehel sometimes appends ("מעיין ברגר, (052)…").
            clean(
              raws.find((r) => !r.is_meeting && clean(r.agent))?.agent,
            ).split(",")[0].trim(),
          source: clean(l?.media_source_raw),
          mediaSource: clean(l?.media_source_raw),
          dealType: "",
          rooms: clean(l?.needs_rooms),
          notes: "",
          leadCreated: clean(l?.registered_at).slice(0, 10),
          firstTouch: journey[0]?.date ?? "",
          lastTouch: journey[journey.length - 1]?.date ?? "",
          touchesCount: journey.length,
          meetingsCount: journey.filter((t) => t.isMeeting).length,
          leadsCount: raws.filter((r) => r.is_lead_event).length,
          objections: clean(l?.objections),
          journey,
        };
      });

      /** The meeting touch nearest this date, within three days — the desk
       *  sometimes writes it up the next morning. */
      const touchFor = (clientId: string, on: string): DossierTouch | null => {
        const list = (touches.get(clientId) ?? []).filter((t) => t.isMeeting);
        if (!list.length || !on) return null;
        const target = Date.parse(`${on}T00:00:00Z`);
        let best: DossierTouch | null = null;
        let bestGap = Infinity;
        for (const t of list) {
          const gap = Math.abs(Date.parse(`${t.date}T00:00:00Z`) - target);
          if (!Number.isFinite(gap) || gap > 3 * 86400000) continue;
          if (gap < bestGap) {
            bestGap = gap;
            best = t;
          }
        }
        return best;
      };
      const noteFor = (clientId: string, on: string): string =>
        sehelNoteBody(touchFor(clientId, on)?.content ?? "");
      const agentFor = (clientId: string, on: string): string => {
        const t = touchFor(clientId, on);
        // Who was in the room beats who owns the lead beats who booked it.
        const attendees = sehelAttendees(t?.content ?? "");
        if (attendees.length) return attendees[0];
        const rep = sehelRepSuffix(clean(leadFor(clientId)?.project_name), accounts);
        if (rep) return rep;
        return sehelBookedBy(t?.agent ?? "") || sehelBookedBy(t?.content ?? "");
      };

      // BMBY numbers a client's meetings; Sehel does not. Derived from the
      // order they were held, oldest first, so #2 means the same thing on
      // both platforms.
      const seqByMeeting = new Map<string, number>();
      const byClientAsc = new Map<string, SehelMeetingRow[]>();
      for (const m of held) {
        const id = clean(m.client_uuid);
        byClientAsc.set(id, [...(byClientAsc.get(id) ?? []), m]);
      }
      for (const [, list] of byClientAsc) {
        list
          .slice()
          .sort((a, b) => clean(a.starts_at).localeCompare(clean(b.starts_at)))
          .forEach((m, i) => seqByMeeting.set(clean(m.event_uid), i + 1));
      }

      const meetings: HeldMeeting[] = capped.map((r) => {
        const clientId = clean(r.client_uuid);
        const date = clean(r.starts_at).slice(0, 10);
        const l = leadFor(clientId);
        const source = clean(l?.media_source_raw);
        const agent = agentFor(clientId, date);
        const reg = clean(l?.registered_at).slice(0, 10);
        let age: number | null = null;
        if (reg && date) {
          const d = Math.round(
            (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${reg}T00:00:00Z`)) /
              86400000,
          );
          age = Number.isFinite(d) && d >= 0 ? d : null;
        }
        return {
          meetingId: clean(r.event_uid),
          clientId,
          date,
          // Sehel records one timestamp, when the meeting is. There is no
          // separate "when it was booked", so the pair collapses rather
          // than inventing a second date.
          bookedDate: "",
          seq: seqByMeeting.get(clean(r.event_uid)) ?? 1,
          kind: clean(r.meeting_type),
          subject: clean(r.meeting_type),
          agents: agent ? [agent] : [],
          firstSource: source,
          firstChannel: "",
          lastSource: source,
          sourceMoved: false,
          leadAgeDays: age,
          note: noteFor(clientId, date),
        };
      });

      return {
        meetings,
        clients,
        total: held.length,
        clientsMet: ids.length,
        withNotes: meetings.filter((m) => m.note).length,
      };
    } catch (e) {
      console.warn(
        `[getHeldMeetingsSehel] failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  },
);
