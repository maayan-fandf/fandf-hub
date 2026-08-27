import { cache } from "react";
import { supabaseConfigured, supabaseRowsAll } from "@/lib/supabase";

/**
 * "Who actually signed?" — the clients behind a project's מכירות number,
 * with enough of their record to answer the next question without leaving
 * the hub: who they are, what they were buying, where they came from, and
 * the touch-by-touch journey that got them there.
 *
 * WHY THIS IS A SEPARATE ENDPOINT rather than another field on the report
 * payload: it is the only surface in the hub that carries a lead's NAME and
 * PHONE. Shipping that in every project render would put customer PII in the
 * RSC flight payload — and in view-source — of every page load for every
 * viewer. It is fetched on demand, by an internal user, only when the
 * מכירות bar is actually clicked.
 *
 * ON THE NUMBER NOT MATCHING THE BAR. The funnel's מכירות comes from ALL
 * CLIENTS' `מכירות` column — an aggregate with no client identity behind it.
 * This list comes from the CRM (`client_status = 'חוזה'`, deduped by
 * client_id). The two are different counts of the same thing and they can
 * disagree; the panel says so rather than implying the list explains the
 * bar.
 *
 * ON JOURNEY COVERAGE. `bmby_touches` is NOT a random sample. Measured
 * 2026-08-27 across the whole warehouse: 5,308 clients have a meeting,
 * 5,152 have a journey, and 5,116 are in both — a 96.4% overlap, with only
 * 36 journeys belonging to a client with no meeting. The detailed lead page
 * is synced when a meeting exists, which is why journey coverage reads ~7%
 * against all leads but ~32% against signed ones. A client who reached a
 * contract has almost always had a meeting, so this feature's own cohort is
 * the best-covered part of the table — but `journey: []` still has to render
 * as "not synced", never as "no contact was made".
 */

/** Journey rows per client. A busy client runs 15-20 touches; this only
 *  bounds a pathological one. */
const MAX_TOUCHES = 400;

/** Signed clients per account. Far above any real project's lifetime count. */
const MAX_CLIENTS = 200;

const CONTRACT_STATUS = "חוזה";

export type JourneyTouch = {
  /** YYYY-MM-DD. */
  date: string;
  /** Task / SMS / LID / Appointment / Comment / Phone / Unknown. */
  type: string;
  /** BMBY user who logged it. */
  agent: string;
  /** Free text the desk typed ("אין מענה"), or the subject line. */
  content: string;
  isMeeting: boolean;
};

export type SignedClient = {
  clientId: string;
  name: string;
  phone: string;
  /** BMBY current status + the fuller stage label ("שלב מכירה: חוזה"). */
  status: string;
  stage: string;
  salesperson: string;
  /** `source_agg` — can be composite ("facebook,טלפון כוכבית Kenko"). */
  source: string;
  /** Cleaned media source off the lead row, when the fuller one is absent. */
  mediaSource: string;
  dealType: string;
  rooms: string;
  /** Free-text notes; on many rows this is the landing URL with its UTMs. */
  notes: string;
  /** Lead-creation date. Shown so the reader can see how far back the list
   *  reaches, WITHOUT implying the signing happened then — BMBY records no
   *  signing date at all. */
  leadCreated: string;
  firstTouch: string;
  lastTouch: string;
  touchesCount: number;
  meetingsCount: number;
  leadsCount: number;
  objections: string;
  /** Empty when the detailed lead page was never synced — see the module
   *  doc. The panel must not read that as "no contact". */
  journey: JourneyTouch[];
};

export type SignedClientsResult = {
  clients: SignedClient[];
  /** How many signed clients the CRM found, before any cap. */
  total: number;
  /** …of which have a synced journey. Rendered as coverage, so a thin
   *  result reads as a sync gap rather than an inactive desk. */
  withJourney: number;
};

type DailyRow = {
  client_id: string | null;
  client_name: string | null;
  phone: string | null;
  client_status: string | null;
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

const clean = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();

/** PostgREST `in.(…)` list of quoted ids, chunked by the caller. */
const inList = (ids: readonly string[]) =>
  ids.map((v) => `"${v.replace(/"/g, "")}"`).join(",");

export const getSignedClients = cache(
  async (args: {
    /** BMBY account name(s) from Keys.CRM — the warehouse's project_name. */
    crmAccounts: readonly string[];
  }): Promise<SignedClientsResult | null> => {
    const accounts = args.crmAccounts.map(clean).filter(Boolean);
    if (!supabaseConfigured() || !accounts.length) return null;
    try {
      // NOT windowed, deliberately. `client_status` is a SNAPSHOT with no
      // signing date anywhere in the warehouse — the only date on the row is
      // when the LEAD came in. Filtering on that asks "which leads created
      // this month have since signed", and since signing takes months the
      // answer is almost always nobody: לוריא's August window returned 0
      // against a bar reading 1. So this returns everyone currently at
      // חוזה for the account, newest lead first, and the panel says that is
      // what it is rather than implying a period.
      const or = accounts
        .map((a) => `project_name.ilike.${encodeURIComponent(a)}*`)
        .join(",");
      const daily = await supabaseRowsAll<DailyRow>(
        `bmby_leads_daily?or=(${or})` +
          `&client_status=eq.${encodeURIComponent(CONTRACT_STATUS)}` +
          `&select=client_id,client_name,phone,client_status,media_source_clean,` +
          `salesperson,agent,objections,lead_created_at&order=lead_created_at.desc`,
        { maxRows: 5000 },
      );
      // One entry per client — a client can hold several lead rows.
      const byClient = new Map<string, DailyRow>();
      for (const r of daily) {
        const id = clean(r.client_id);
        if (!id || byClient.has(id)) continue;
        byClient.set(id, r);
      }
      const total = byClient.size;
      if (!total) return { clients: [], total: 0, withJourney: 0 };
      const ids = [...byClient.keys()].slice(0, MAX_CLIENTS);

      // The richer record + the journey. Both are keyed on the same
      // client_id (verified: identical format across all four bmby tables),
      // and both are best-effort — a signed client with neither still
      // renders from the daily row above.
      const leads = new Map<string, LeadRow>();
      const touches = new Map<string, JourneyTouch[]>();
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const [lr, tr] = await Promise.all([
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
        for (const r of lr) {
          const id = clean(r.client_id);
          if (id && !leads.has(id)) leads.set(id, r);
        }
        for (const r of tr) {
          const id = clean(r.client_id);
          if (!id) continue;
          const list = touches.get(id) ?? [];
          if (list.length >= MAX_TOUCHES) continue;
          list.push({
            date: clean(r.event_date).slice(0, 10),
            type: clean(r.type) || "—",
            agent: clean(r.user_name),
            // `content` is the desk's free text; `subject` fills in for the
            // event types that carry a subject line instead.
            content: clean(r.content) || clean(r.subject),
            isMeeting: !!r.is_meeting,
          });
          touches.set(id, list);
        }
      }

      const clients: SignedClient[] = ids.map((id) => {
        const d = byClient.get(id)!;
        const l = leads.get(id);
        const journey = touches.get(id) ?? [];
        return {
          clientId: id,
          // The detailed record's name wins — the daily row truncates.
          name: clean(l?.name) || clean(d.client_name),
          phone: clean(l?.phone_normalized) || clean(d.phone),
          status: clean(l?.current_status) || clean(d.client_status),
          stage: clean(l?.stage_name),
          salesperson: clean(l?.salesperson) || clean(d.salesperson) || clean(d.agent),
          source: clean(l?.source_agg),
          mediaSource: clean(d.media_source_clean),
          dealType: clean(l?.deal_type),
          rooms: clean(l?.rooms),
          notes: clean(l?.notes),
          firstTouch: clean(l?.first_touch_date).slice(0, 10),
          lastTouch: clean(l?.last_touch_date).slice(0, 10),
          touchesCount: Number(l?.touches_count ?? journey.length) || journey.length,
          meetingsCount: Number(l?.meetings_count ?? 0) || 0,
          leadsCount: Number(l?.lids_count ?? 0) || 0,
          leadCreated: clean(d.lead_created_at).slice(0, 10),
          objections: clean(d.objections),
          journey,
        };
      });

      return {
        clients,
        total,
        withJourney: clients.filter((c) => c.journey.length > 0).length,
      };
    } catch (e) {
      console.warn(
        `[getSignedClients] failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  },
);
