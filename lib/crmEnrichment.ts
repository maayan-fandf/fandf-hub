/**
 * Supabase BMBY warehouse → CRM-funnel enrichment (ADDITIVE, bmby-only,
 * flag-gated). Attaches authoritative held-meeting counts (Slice A; speed-
 * to-lead / objections / agent scoreboard land in later slices) alongside
 * the Sheet-derived funnel.
 *
 * The blessed `get_*` RPCs aren't PostgREST-reachable, so we re-derive from
 * the raw v_bmby_* views using Nadav's locked canonical filters — validated
 * to reproduce his live numbers (Netivot May: held 45, scheduled 193,
 * leads 933). See bmby-supabase-integration-plan.md §12.
 *
 * Never throws to the caller: every fn degrades to null/0 on error so a
 * warehouse hiccup leaves the base Sheet funnel untouched. Wrapped in
 * unstable_cache(300s) + React cache() — same two-layer pattern as
 * lib/keys.ts.
 */
import { unstable_cache } from "next/cache";
import { cache } from "react";
import { supabaseCount, supabaseRows, supabaseConfigured } from "./supabase";

export type BmbyHeldEnrichment = {
  /** appointment_outcome='held' — BMBY-confirmed, per-event (ties to
   *  bmby_agent_summary.performed_appointments). The trustworthy number. */
  authoritative: number;
  /** held boolean = confirmed + status-inferred. Over-counts; surface as
   *  "estimated / כולל משוער" only. */
  estimated: number;
  /** appointment_outcome='canceled' in the window. */
  canceled: number;
  /** distinct-lead first meetings (meeting_seq=1) — "leads first-booked". */
  scheduledFirstMeetings: number;
  /** Freshness ISO (max last_synced_at on bmby_meetings). "" if unknown. */
  asOf: string;
};

export type CrmEnrichment = {
  /** Numeric BMBY project_id resolved via v_report_v2_bmby_projects. */
  projectId: number;
  held: BmbyHeldEnrichment;
} | null;

/** Resolve a BMBY account name (Keys.CRM == project_he) → numeric
 *  project_id. Returns null when the name isn't a known warehouse project
 *  (→ caller leaves the base funnel untouched). */
async function resolveProjectId(
  crmAccount: string,
): Promise<{ projectId: number; projectName: string } | null> {
  const name = crmAccount.trim();
  if (!name) return null;
  const rows = await supabaseRows<{ project_id: number; project_name: string }>(
    `v_report_v2_bmby_projects?select=project_id,project_name&project_name=eq.${encodeURIComponent(name)}`,
  );
  if (rows.length && rows[0].project_id != null) {
    return { projectId: Number(rows[0].project_id), projectName: String(rows[0].project_name) };
  }
  return null;
}

async function freshnessIso(): Promise<string> {
  const rows = await supabaseRows<{ last_synced_at: string }>(
    `bmby_meetings?select=last_synced_at&order=last_synced_at.desc&limit=1`,
  );
  return rows.length ? String(rows[0].last_synced_at || "") : "";
}

/** Held breakdown for one project over [from, toExcl). Keys on project_he
 *  (the Hebrew account name) until Nadav adds project_id to the journey
 *  view. `from`/`toExcl` empty → no date filter (all rows). */
async function bmbyHeld(
  projectHe: string,
  from: string,
  toExcl: string,
): Promise<BmbyHeldEnrichment> {
  const base = `v_bmby_journey_meetings?project_he=eq.${encodeURIComponent(projectHe)}`;
  const win =
    from && toExcl ? `&meeting_date=gte.${from}&meeting_date=lt.${toExcl}` : "";
  const [authoritative, estimated, canceled, scheduledFirstMeetings, asOf] =
    await Promise.all([
      supabaseCount(`${base}${win}&appointment_outcome=eq.held&select=meeting_id`),
      supabaseCount(`${base}${win}&held=is.true&select=meeting_id`),
      supabaseCount(`${base}${win}&appointment_outcome=eq.canceled&select=meeting_id`),
      supabaseCount(`${base}${win}&meeting_seq=eq.1&select=meeting_id`),
      freshnessIso(),
    ]);
  return {
    authoritative: authoritative ?? 0,
    estimated: estimated ?? 0,
    canceled: canceled ?? 0,
    scheduledFirstMeetings: scheduledFirstMeetings ?? 0,
    asOf,
  };
}

async function computeUncached(
  crmAccount: string,
  from: string,
  toExcl: string,
): Promise<CrmEnrichment> {
  if (!supabaseConfigured()) return null;
  const resolved = await resolveProjectId(crmAccount);
  if (!resolved) return null;
  const held = await bmbyHeld(crmAccount, from, toExcl);
  return { projectId: resolved.projectId, held };
}

const computeCrossRequest = unstable_cache(
  (crmAccount: string, from: string, toExcl: string) =>
    computeUncached(crmAccount, from, toExcl),
  ["bmbyCrmEnrichment"],
  { revalidate: 300, tags: ["supabaseCrm"] },
);

/** Public entry — bmby account name + window bounds → enrichment, or null.
 *  Per-request deduped, cross-request cached 300s. Caller must already have
 *  gated on `platform === "bmby"` + `useSupabaseCrmEnrichment()`. */
export const computeCrmEnrichment = cache(
  (crmAccount: string, from: string, toExcl: string) =>
    computeCrossRequest(crmAccount, from, toExcl),
);
