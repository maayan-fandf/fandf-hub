import { cache } from "react";
import { orExactFilter, supabaseConfigured, supabaseRowsAll } from "@/lib/supabase";
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
 * ── BMBY only ──
 * `v_bmby_journey_meetings` has no Sehel or Salesforce equivalent carrying a
 * per-meeting outcome plus a touch trail. The route answers those platforms
 * with a reason rather than an error, so the panel can say why it is empty
 * instead of implying there were no meetings.
 *
 * ── On the objections column ──
 * BMBY records objections against the CLIENT, not against a meeting, and
 * there is no timestamp that would tie one to the other. What this returns
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
      const leads = new Map<string, LeadRow>();
      const touches = new Map<string, DossierTouch[]>();
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const [dr, lr, tr] = await Promise.all([
          supabaseRowsAll<DailyRow>(
            `bmby_leads_daily?client_id=in.(${inList(chunk)})` +
              `&select=client_id,client_name,phone,client_status,pipeline,` +
              `media_source_clean,salesperson,agent,objections,lead_created_at` +
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
        for (const r of dr) {
          const id = clean(r.client_id);
          if (id && !daily.has(id)) daily.set(id, r);
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
          journey,
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
