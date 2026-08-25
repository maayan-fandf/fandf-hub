import { unstable_cache } from "next/cache";
import { cache } from "react";
import { sheetsClient, driveFolderOwner } from "@/lib/sa";
import { readKeysCached } from "@/lib/keys";
import { supabaseConfigured, supabaseRows } from "@/lib/supabase";
import { canonicalMediaChannel, type CrmPlatform } from "@/lib/crmData";

/**
 * Per-channel meeting counts keyed by the date the meeting ACTUALLY
 * HAPPENED, for all three CRM platforms.
 *
 * WHY THIS EXISTS. Every held-meeting number the hub shows today is a
 * SNAPSHOT: it counts leads *created* in the window whose status is
 * *currently* held. That is a cohort measure, and it has two properties
 * that make it a poor partner for a spend column:
 *
 *   1. It restates. Measured 2026-08-25 across all BMBY projects: leads
 *      created in June had 335 held meetings by the end of June, 435 by
 *      today — the number you read at month-end grew 30% afterwards.
 *      July went 291 → 365 and is still climbing.
 *   2. Its per-channel split differs from what actually happened. Same
 *      measurement, July, facebook: 82 by the snapshot, 129 by meeting
 *      date. Cost-per-meeting for the biggest channel moves by ~57%
 *      depending purely on which definition the table uses.
 *
 * Totals can hide this. Across Salesforce in July the two agree almost
 * exactly (77 vs 75) while only 52 rows are common to both — a third of
 * each number is different meetings. So "the totals look fine" is not
 * evidence the attribution is fine.
 *
 * Neither definition is wrong; they answer different questions ("how good
 * were July's leads" vs "how many meetings happened in July"). This module
 * supplies the second one so the ערוצים table can offer both and let the
 * reader pick — see the dated/snapshot toggle in ReportChannelsTab.
 *
 * THREE PLATFORMS, THREE SOURCES — and only two of them are in Supabase:
 *
 *   bmby       v_bmby_journey_meetings         warehouse, per-event
 *   sehel      sehel_meetings + sehel_leads_daily   warehouse, joined on client
 *   salesforce a tab in the SHBN gathering workbook  SHEET — no warehouse table
 *
 * Never throws: every branch degrades to null so a warehouse or Sheets
 * hiccup costs the toggle, not the table.
 */

const TTL_SECONDS = 300;
const CACHE_TAG = "datedChannelMeetings";

/** Salesforce meeting rows live in the SHBN "gathering" workbook, NOT in
 *  the Consolidated CRM workbook the rest of crmData reads. The tab is a
 *  CSV drop, so its name carries the original file name verbatim. */
const SF_MEETINGS_SHEET_ID = "1Teq6FVte2NpRavE6_ueWgREAgbDq8Va-xtNYudpeRf4";
const SF_MEETINGS_TAB = "פגישות שנקבעו בהזדמנותלפי ת. יצירת ליד (1).csv";

export type DatedCounts = { scheduled: number; held: number };

export type DatedChannelMeetings = {
  platform: CrmPlatform;
  /** canonical channel key → counts of meetings whose EVENT DATE is in
   *  the window. Key with `datedChannelKey` on the other side too. */
  byChannel: Record<string, DatedCounts>;
  /** Meetings in the window whose lead carried no usable source. Surfaced
   *  rather than silently dropped: if this is large, the per-channel split
   *  is understating everything and the reader should know. */
  unattributed: DatedCounts;
  /**
   * How much the held figure can be trusted.
   *   "authoritative" — the source records a per-MEETING outcome (BMBY's
   *      appointment_outcome, Salesforce's סטטוס הפגישה).
   *   "partial" — some meetings have no resolved outcome, so held is a
   *      floor, not a count. Sehel: ~26% of meetings sit at "לא ידוע".
   */
  heldConfidence: "authoritative" | "partial";
  /** Meetings in the window with no resolved outcome either way (drives
   *  the "partial" caveat in the UI). */
  unresolved: number;
};

function norm(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Non-paid buckets `canonicalMediaChannel` deliberately returns null for.
 *
 * That function exists for COST attribution, where "this source has no
 * media spend" is the correct answer and null is load-bearing — so it is
 * left alone. Here the job is different: a channel row for טלפוניה still
 * needs its meetings counted, it just has no cost to divide by.
 */
const NON_PAID: [RegExp, string][] = [
  // Referral BEFORE phone, and the order is load-bearing: "הפניה מהיזם"
  // (a developer referral) contains "פניה", so a phone-first list files
  // every developer referral as a phone enquiry. The reverse can't happen
  // — "פניה טלפונית" has no leading ה — so referral-first is safe.
  [/חבר\s?מביא\s?חבר|referral|הפניה|המלצה/, "referral"],
  [/phone|טלפו|פניה|פנייה|call/, "phone"],
  [/משרד\s?מכירות|sales\s?office|walk[\s_-]?in/, "sales-office"],
  [/minisite|מיני-?סייט/, "minisite"],
  [/website|אתר|צור\s?קשר/, "website"],
  [/radio|רדיו/, "radio"],
  [/שילוט|שלט|billboard|חוצות/, "billboard"],
  [/manual|ידני/, "manual"],
];

/**
 * One key both sides of the join agree on.
 *
 * Callers pass three different vocabularies at this: ALL CLIENTS channel
 * names (the table's rows), the warehouse's own shorthand (fb / gs /
 * discovery), and free-form CRM source strings ("facebook lead generation
 * Fandf_…", "גוגל", "Yad2"). canonicalMediaChannel already normalises all
 * three for paid media — including the fb/gs/discovery shorthand — so it
 * leads, the non-paid table fills the gap, and anything still unmatched
 * falls back to its own normalised string so two identical vendor names
 * (e.g. "hiway") still meet instead of both vanishing.
 */
export function datedChannelKey(name: string): string {
  const paid = canonicalMediaChannel(name);
  if (paid) return paid;
  const n = norm(name);
  if (!n || n === "—") return "";
  for (const [re, key] of NON_PAID) if (re.test(n)) return key;
  return n;
}

function emptyCounts(): DatedCounts {
  return { scheduled: 0, held: 0 };
}

function tally(
  into: Record<string, DatedCounts>,
  key: string,
  held: boolean,
): void {
  const row = (into[key] ??= emptyCounts());
  row.scheduled++;
  if (held) row.held++;
}

/** Keys' `CRM` cell can hold several comma-joined accounts — but a comma
 *  can also be INSIDE one name ("בית צורי 22,24"). Match either reading,
 *  same as crmData's private crmAccountCandidates. */
function accountCandidates(raw: string): string[] {
  const full = String(raw ?? "").trim();
  if (!full) return [];
  const parts = full.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length > 1 ? [full, ...parts] : [full];
}

/** (project, company) → the Keys CRM account + platform, or null when the
 *  project has no CRM mapping. Mirrors getCrmFunnelForProject's own lookup
 *  (which keeps it inline) including the כללי company disambiguation. */
async function resolveCrm(
  project: string,
  company: string,
): Promise<{ account: string; platform: CrmPlatform } | null> {
  const { headers, rows } = await readKeysCached(driveFolderOwner());
  const iProj = headers.indexOf("פרוייקט");
  const iCo = headers.indexOf("חברה");
  const iCrm = headers.indexOf("CRM");
  const iPlat = headers.indexOf("CRM platform");
  if (iProj < 0 || iCrm < 0 || iPlat < 0) return null;
  for (const r of rows) {
    const row = r as unknown[];
    const rp = String(row[iProj] ?? "").trim();
    if (rp !== project.trim()) continue;
    const rc = iCo >= 0 ? String(row[iCo] ?? "").trim() : "";
    if (rc && company.trim() && rc !== company.trim()) continue;
    const account = String(row[iCrm] ?? "").trim();
    const platform = String(row[iPlat] ?? "").trim().toLowerCase();
    if (!account) return null;
    if (platform === "bmby" || platform === "sehel" || platform === "salesforce") {
      return { account, platform };
    }
    return null;
  }
  return null;
}

/* ── BMBY ─────────────────────────────────────────────────────────────
 * The journey view already carries everything: one row per meeting, its
 * date, its per-event outcome, and the lead's channel.
 *
 * `appointment_outcome` — NOT the `held` boolean. The boolean is
 * confirmed-plus-status-inferred and over-counts (see crmEnrichment's
 * BmbyHeldEnrichment, which surfaces it separately as "estimated").
 * Channel coverage measured 2026-08-25: first_lid_channel was present on
 * 100% of the last 90 days' meetings.
 */
type BmbyRow = {
  first_lid_channel: string | null;
  appointment_outcome: string | null;
};

async function bmbyDated(
  account: string,
  from: string,
  to: string,
): Promise<DatedChannelMeetings | null> {
  const rows = await supabaseRows<BmbyRow>(
    `v_bmby_journey_meetings?select=first_lid_channel,appointment_outcome` +
      `&project_he=eq.${encodeURIComponent(account)}` +
      `&meeting_date=gte.${from}&meeting_date=lte.${to}&limit=20000`,
  );
  if (!rows.length) return null;
  const byChannel: Record<string, DatedCounts> = {};
  const unattributed = emptyCounts();
  let unresolved = 0;
  for (const r of rows) {
    const outcome = norm(r.appointment_outcome);
    const held = outcome === "held";
    if (!outcome || outcome === "in_process") unresolved++;
    const key = datedChannelKey(r.first_lid_channel ?? "");
    if (!key) {
      unattributed.scheduled++;
      if (held) unattributed.held++;
      continue;
    }
    tally(byChannel, key, held);
  }
  return {
    platform: "bmby",
    byChannel,
    unattributed,
    heldConfidence: "authoritative",
    unresolved,
  };
}

/* ── Sehel ────────────────────────────────────────────────────────────
 * Meetings and channels live in two tables joined on the client UUID.
 * Measured 2026-08-25: every meeting in the last 90 days carried a
 * client_uuid and every sampled uuid resolved in sehel_leads_daily.
 *
 * Held is weaker here than on the other two platforms: the status
 * vocabulary is {הלקוח הגיע לפגישה, יש אישור הגעה, לא ידוע, הלקוח ביקש
 * לבטל} and about a quarter of meetings sit at "לא ידוע" — genuinely
 * unknown, not zero. Hence heldConfidence "partial".
 *
 * Sehel accounts match by PREFIX (crmData does the same) because the
 * warehouse project_name carries a longer descriptive tail than Keys.
 */
const SEHEL_HELD = "הלקוח הגיע לפגישה";
const SEHEL_UNKNOWN = "לא ידוע";

type SehelMeeting = { client_uuid: string | null; status_label: string | null };
type SehelLead = { client_uuid: string | null; media_source_raw: string | null };

/** PostgREST `like` treats `*` as the wildcard; the value still has to be
 *  escaped or a name with a comma/paren truncates the filter. */
function likePrefix(v: string): string {
  return encodeURIComponent(`${v}*`);
}

async function sehelDated(
  account: string,
  from: string,
  to: string,
): Promise<DatedChannelMeetings | null> {
  // starts_at is a timestamptz — bound with a half-open day range rather
  // than lte on a bare date, which would drop everything after midnight
  // on the closing day.
  const toExcl = new Date(Date.parse(`${to}T00:00:00Z`) + 86400000)
    .toISOString()
    .slice(0, 10);
  const meetings = await supabaseRows<SehelMeeting>(
    `sehel_meetings?select=client_uuid,status_label` +
      `&project_name=like.${likePrefix(account)}` +
      `&starts_at=gte.${from}T00:00:00&starts_at=lt.${toExcl}T00:00:00&limit=20000`,
  );
  if (!meetings.length) return null;

  const uuids = [...new Set(meetings.map((m) => m.client_uuid).filter(Boolean))];
  const sourceByUuid = new Map<string, string>();
  // Chunked: a project-season's worth of uuids overflows a practical URL.
  for (let i = 0; i < uuids.length; i += 150) {
    const chunk = uuids.slice(i, i + 150);
    const leads = await supabaseRows<SehelLead>(
      `sehel_leads_daily?select=client_uuid,media_source_raw` +
        `&client_uuid=in.(${chunk.join(",")})&limit=20000`,
    );
    for (const l of leads) {
      if (l.client_uuid && l.media_source_raw) {
        sourceByUuid.set(String(l.client_uuid), String(l.media_source_raw));
      }
    }
  }

  const byChannel: Record<string, DatedCounts> = {};
  const unattributed = emptyCounts();
  let unresolved = 0;
  for (const m of meetings) {
    const status = String(m.status_label ?? "").trim();
    const held = status === SEHEL_HELD;
    if (!status || status === SEHEL_UNKNOWN) unresolved++;
    const key = datedChannelKey(sourceByUuid.get(String(m.client_uuid)) ?? "");
    if (!key) {
      unattributed.scheduled++;
      if (held) unattributed.held++;
      continue;
    }
    tally(byChannel, key, held);
  }
  return {
    platform: "sehel",
    byChannel,
    unattributed,
    heldConfidence: "partial",
    unresolved,
  };
}

/* ── Salesforce ───────────────────────────────────────────────────────
 * No warehouse table exists, so this reads the SHBN gathering workbook
 * directly. Columns (verified 2026-08-25 over 1,722 rows):
 *   A תאריך              the MEETING date — 100% parseable, and of the 328
 *                        held rows ZERO are future-dated while 30 of the
 *                        not-yet-held ones are, which is the asymmetry a
 *                        real meeting date must have.
 *   E שלב הזדמנות        the OPPORTUNITY's stage — a snapshot. NOT used.
 *   O פרויקט             97% populated.
 *   P סטטוס הפגישה       THIS meeting's own outcome. Used.
 *   Q מקור הליד          the lead's channel.
 *
 * E vs P matters: they disagree on ~10% of rows (104 read "contract
 * signed" on E while P says that meeting was cancelled — coherent, they
 * rebooked). E is the lead-level snapshot this module exists to avoid;
 * P is the per-event truth. Reading E here would silently reintroduce
 * exactly the semantics the toggle is meant to offer an alternative to.
 */
const SF_HELD = "התקיימה";
const SF_PENDING = "טרם התקיימה";

/** The tab writes dates as d.m.yyyy. Anything else is left unparsed and
 *  the row is skipped rather than guessed into the wrong window. */
function sfIsoDate(v: unknown): string {
  const m = String(v ?? "").trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  return m
    ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`
    : "";
}

const readSfMeetings = cache(async (): Promise<unknown[][]> => {
  const sheets = sheetsClient(driveFolderOwner());
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SF_MEETINGS_SHEET_ID,
    range: `'${SF_MEETINGS_TAB}'!A:Q`,
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  return ((res.data.values ?? []) as unknown[][]).slice(1);
});

async function salesforceDated(
  account: string,
  from: string,
  to: string,
): Promise<DatedChannelMeetings | null> {
  const rows = await readSfMeetings();
  if (!rows.length) return null;
  const targets = new Set(accountCandidates(account).map(norm));
  if (!targets.size) return null;

  const byChannel: Record<string, DatedCounts> = {};
  const unattributed = emptyCounts();
  let unresolved = 0;
  let matched = 0;
  for (const r of rows) {
    // O פרויקט is blank on ~3% of rows; the נושא text spells the project
    // out ("פגישה עם … בפרויקט נשר") and rescues most of those.
    let proj = norm(r[14]);
    if (!proj) {
      const m = String(r[7] ?? "").match(/בפרויקט\s+(.+)$/);
      proj = m ? norm(m[1]) : "";
    }
    if (!proj || !targets.has(proj)) continue;
    const date = sfIsoDate(r[0]);
    if (!date || date < from || date > to) continue;
    matched++;
    const status = String(r[15] ?? "").trim();
    const held = status === SF_HELD;
    if (!status || status === SF_PENDING) unresolved++;
    const key = datedChannelKey(String(r[16] ?? ""));
    if (!key) {
      unattributed.scheduled++;
      if (held) unattributed.held++;
      continue;
    }
    tally(byChannel, key, held);
  }
  if (!matched) return null;
  return {
    platform: "salesforce",
    byChannel,
    unattributed,
    heldConfidence: "authoritative",
    unresolved,
  };
}

async function computeUncached(
  project: string,
  company: string,
  from: string,
  to: string,
): Promise<DatedChannelMeetings | null> {
  if (!project || !from || !to || from > to) return null;
  try {
    const crm = await resolveCrm(project, company);
    if (!crm) return null;
    if (crm.platform === "salesforce") {
      return await salesforceDated(crm.account, from, to);
    }
    // Both warehouse platforms need a key; without one the toggle simply
    // doesn't offer itself rather than reporting zeros.
    if (!supabaseConfigured()) return null;
    return crm.platform === "bmby"
      ? await bmbyDated(crm.account, from, to)
      : await sehelDated(crm.account, from, to);
  } catch (e) {
    console.warn(
      `[datedChannelMeetings] ${project}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

const computeCrossRequest = unstable_cache(
  computeUncached,
  ["datedChannelMeetings"],
  { revalidate: TTL_SECONDS, tags: [CACHE_TAG] },
);

/**
 * Per-channel meetings dated by when they HAPPENED, over [from, to]
 * inclusive. Null when the project has no CRM mapping, the platform's
 * source is unreachable, or nothing matched — all of which mean "offer
 * the snapshot only", never "show zeros".
 */
export const getDatedChannelMeetings = cache(
  (args: { project: string; company: string; from: string; to: string }) =>
    computeCrossRequest(args.project, args.company, args.from, args.to),
);
