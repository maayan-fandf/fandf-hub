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

/**
 * What counts as a sale, and where it is written.
 *
 * BMBY tenants do not agree on the field. Measured across the warehouse
 * (2026-01 onward): 190 rows mark it as client_status "חוזה" and 84 as
 * "ברכישה", while a separate 85 sit in the `pipeline` column as "חוזה" and
 * 50 as "הסכם ראשוני". Checking only client_status — which this did — made
 * whole projects come back empty: צרפתי's דרימס ארנונה ירושלים has 2,181
 * leads and not one "חוזה" status, but 8 in a sale pipeline; פסגת זאב,
 * אורנבך and באר יעקב מערב are the same shape.
 *
 * SIGNED vs OPPORTUNITY is kept apart rather than merged. "הסכם ראשוני" is
 * a commitment; "הזדמנות מכירה" is the stage before one. Counting the
 * second as a sale would inflate לוריא from 4 to 8, so the panel shows both
 * and labels which is which.
 */
const SIGNED_STATUS = new Set(["חוזה", "ברכישה"]);
const SIGNED_PIPELINE = new Set(["חוזה", "הסכם ראשוני"]);
const OPPORTUNITY_PIPELINE = new Set(["הזדמנות מכירה"]);

/** "signed" | "opportunity" | "" (not a sale row at all). */
function saleStageOf(status: unknown, pipeline: unknown): "" | "signed" | "opportunity" {
  const st = clean(status);
  const pl = clean(pipeline);
  if (SIGNED_STATUS.has(st) || SIGNED_PIPELINE.has(pl)) return "signed";
  if (OPPORTUNITY_PIPELINE.has(pl)) return "opportunity";
  return "";
}

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
  /** How many SIGNED clients the CRM found, before any cap. */
  total: number;
  /** …and how many are only at the opportunity stage. Counted apart so the
   *  headline number stays "sales" rather than "sales plus maybes". */
  opportunities: number;
  /** …of which have a synced journey. Rendered as coverage, so a thin
   *  result reads as a sync gap rather than an inactive desk. */
  withJourney: number;
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
      // Filtered in memory rather than server-side: the sale can sit in
      // EITHER client_status or pipeline (see saleStageOf), and expressing
      // "account matches AND (any of five values across two columns)" as
      // nested PostgREST and=(or(...),or(...)) is exactly the kind of query
      // that silently matches nothing. The account filter already bounds
      // this to one project's leads — a few thousand rows at most.
      const daily = await supabaseRowsAll<DailyRow>(
        `bmby_leads_daily?or=(${or})` +
          `&select=client_id,client_name,phone,client_status,pipeline,` +
          `media_source_clean,salesperson,agent,objections,lead_created_at` +
          `&order=lead_created_at.desc`,
        { maxRows: 20000 },
      );
      // One entry per client — a client can hold several lead rows, and a
      // SIGNED row outranks an opportunity one for the same person.
      const byClient = new Map<string, { row: DailyRow; stage: "signed" | "opportunity" }>();
      for (const r of daily) {
        const id = clean(r.client_id);
        if (!id) continue;
        const stage = saleStageOf(r.client_status, r.pipeline);
        if (!stage) continue;
        const prev = byClient.get(id);
        if (prev && !(prev.stage === "opportunity" && stage === "signed")) continue;
        byClient.set(id, { row: r, stage });
      }
      const signedCount = [...byClient.values()].filter((v) => v.stage === "signed").length;
      const oppCount = byClient.size - signedCount;
      if (!byClient.size)
        return { clients: [], total: 0, opportunities: 0, withJourney: 0 };
      // Signed first, so the cap never trims a sale in favour of a maybe.
      const ids = [...byClient.entries()]
        .sort((a, b) => (a[1].stage === b[1].stage ? 0 : a[1].stage === "signed" ? -1 : 1))
        .map(([id]) => id)
        .slice(0, MAX_CLIENTS);

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
        const hit = byClient.get(id)!;
        const d = hit.row;
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
          saleStage: hit.stage,
          // The tenant's own wording, not our bucket name — פסגת זאב says
          // "הסכם ראשוני" where רעננה קנקו says "חוזה", and flattening that
          // would hide which commitment was actually recorded.
          saleLabel: clean(d.pipeline) || clean(d.client_status),
        };
      });

      return {
        clients,
        total: signedCount,
        opportunities: oppCount,
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
