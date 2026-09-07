import { cache } from "react";
import { crmAccountCandidates } from "@/lib/crmData";
import { readKeysCached } from "@/lib/keys";
import { driveFolderOwner } from "@/lib/sa";
import { orExactFilter, supabaseConfigured, supabaseRowsAll } from "@/lib/supabase";
import { channelSlug } from "@/lib/channelIcon";

/**
 * מקור מול טריגר — where a coordination was OPENED against where it was
 * CLOSED.
 *
 * The report attributes a lead to its LAST touch, which is the honest
 * default and also the reading that makes media look worst: someone finds
 * the project on Facebook, thinks about it for three weeks, then phones in
 * — and the phone takes the credit. Across the warehouse the phone opens
 * 195 coordinations and closes 304; radio opens 125 and closes 211;
 * Facebook opens 2,682 and closes 2,565. Nothing on the report says so,
 * so a campaign that did its job reads as one that did not.
 *
 * This is the context that makes last-touch safe to publish.
 *
 * ONE MATRIX, BOTH COLUMNS. The two lists are the row sums and the column
 * sums of a single first×last matrix, never two separate reads. Two
 * independent counts of "the same coordinations" can drift — a lead
 * dropped by one filter and kept by the other — and then the card is
 * arguing with itself in public. Derived this way they add to the same
 * total by construction, and the drill-down is a slice of the same matrix
 * rather than a third query that might not agree with either column.
 * (The idea and that constraint are MOAD's — nadav-source/moad,
 * src/components/deck/JourneyPanel.tsx.)
 *
 * WINDOWED ON `meeting_date`, the date the coordination was booked — the
 * event this card counts. Not `appointment_date`: a meeting booked inside
 * the window and held after it still belongs to the window's work, and
 * פגישות שהתקיימו is the section that asks the other question.
 *
 * BMBY AND SEHEL, each read by its own half and merged. BMBY comes ready:
 * `v_bmby_journey_meetings` resolves the touch chain into
 * `first_lid_channel` / `last_lid_channel`, both 100% populated. Sehel has
 * no such view, so sehelJourney() resolves the chain here out of the raw
 * touches — see its doc for the three ways that differs and for the
 * coverage the card has to admit to.
 *
 * SALESFORCE CANNOT BE ADDED, and not for want of writing it: its CRM is a
 * Sheet tab (`Salesforce!A:T`) with fifteen columns and exactly one
 * `מקור ליד` per lead. There is no touch history anywhere in it, so first
 * and last are the same value by construction and the card would draw a
 * perfect diagonal and say nothing. Its five projects get null, which the
 * section renders as absence rather than as "nothing moved".
 */

/** Coverage measured 2026-09-07 across the whole view: 17 distinct slugs,
 *  no nulls in either column. Anything new falls through to its own slug,
 *  which is ugly on screen but never silently merges two channels. */
const CHANNEL_LABELS: Record<string, string> = {
  fb: "פייסבוק",
  yad2: "יד2",
  gs: "גוגל חיפוש",
  discovery: "גוגל דיסקאברי",
  pmax: "Performance Max",
  article: "כתבה",
  minisite: "מיניסייט",
  madlan: "מדלן",
  outbrain: "אאוטבריין",
  taboola: "טאבולה",
  radio: "רדיו",
  phone: "פניה טלפונית",
  referral: "הפניה",
  broker: "מתווך",
  walk_in: "הגיע למשרד",
  social: "סושיאל",
  manual: "נפתח ידני",
  // Buckets channelSlug() can produce that BMBY has no native slug for —
  // Sehel genuinely sells off billboards (1,504 lead events, its third
  // channel) and its own sites, and folding those into "אחר" would hide
  // the very thing the column is for.
  billboard: "שילוט",
  site: "אתר החברה",
  whatsapp: "וואטסאפ",
  mail: "דיוור",
  tv: "טלוויזיה",
  other: "אחר",
};

/** The channel-name string ChannelIcon understands, so this card wears the
 *  same marks as every other channel list in the hub instead of inventing
 *  a second visual language for the same eight platforms. */
const CHANNEL_ICON_KEY: Record<string, string> = {
  fb: "facebook",
  yad2: "yad2",
  gs: "google search",
  discovery: "google discovery",
  pmax: "google pmax",
  article: "כתבה",
  minisite: "minisite",
  madlan: "madlan",
  outbrain: "outbrain",
  taboola: "taboola",
  phone: "פניה טלפונית",
  social: "instagram",
  billboard: "שילוט",
  site: "אתר החברה",
  whatsapp: "whatsapp",
  mail: "דיוור",
  radio: "רדיו",
};

export type JourneyChannel = {
  slug: string;
  label: string;
  /** What to hand ChannelIcon; "" for the ones with no brand mark. */
  iconKey: string;
};

export type JourneyCell = { from: string; to: string; count: number };

export type JourneyRow = { slug: string; count: number };

export type LeadJourney = {
  /** Row sums — who opened. */
  origin: JourneyRow[];
  /** Column sums — who closed. */
  trigger: JourneyRow[];
  matrix: JourneyCell[];
  channels: Record<string, JourneyChannel>;
  /** Coordinations in the window. Both columns sum to this. */
  total: number;
  /** How many changed hands between the first touch and the last. The
   *  headline number: everything else on the card explains it. */
  moved: number;
  /** Largest positive trigger−origin gap, which is the channel the note
   *  is about. Null when nothing closes more than it opens. */
  hot: string | null;
  hotDelta: number;
  /**
   * Of the leads that changed channel, how many belong to someone who had
   * inquired before. Null when the returning flag could not be read.
   *
   * This exists because the obvious question about this card is whether it
   * is just לידים חוזרים מול חדשים wearing a different chart, and the
   * answer is worth putting on the screen rather than leaving to be
   * guessed. Measured on נתיבות over 2026: of 205 leads that changed
   * channel, 198 were returning (96.6%) — so a channel change is almost
   * always a person coming back. But only 198 of 350 returning leads
   * changed channel (56.6%): half of them came back through the same
   * channel, which genuinely re-earned them. The two blocks are one event
   * seen from two sides, and neither contains the other.
   */
  returningAmongMoved: number | null;
  /** Sehel only: meetings whose client has NO lead touch recorded, so no
   *  first/last pair could be resolved. Not "people who never changed
   *  channel" — people we cannot see, and the card says so rather than
   *  quietly counting them as stayers. 0 on a BMBY project, where the
   *  warehouse view resolves every row. */
  unresolved: number;
  /** Which CRMs the card is built from. A project on both reads both. */
  platforms: ("bmby" | "sehel")[];
};

type Row = {
  lead_id: string | number | null;
  client_id: string | number | null;
  first_lid_channel: string | null;
  last_lid_channel: string | null;
};

/** PostgREST `in.()` batch size. The same 300-ish ceiling the warehouse
 *  readers already use for ad_id lists — a URL, not a query, is the limit. */
const ID_BATCH = 200;

/** Composite map key for a matrix cell. Every channel slug the view emits
 *  is [a-z_]+, so a pipe cannot collide with one. (It was briefly a literal
 *  NUL, which works and also turns the file binary to grep and invisible to
 *  whoever reads it next.) */
const KEY_SEP = "|";

/**
 * `is_return_lead` for a set of clients.
 *
 * Joined on client_id and NOT on lead_id: the two views number leads in
 * different id spaces — the journey view carries a 16-char hash, the
 * bucketed view the numeric BMBY id — so a lead_id join silently matches
 * nothing at all. (It did, on the first attempt; 908 of 974 clients match
 * on client_id.)
 *
 * Returns null on any failure, which the card renders as "we did not check"
 * rather than as "none of them were returning".
 */
async function returningClients(ids: string[]): Promise<Set<string> | null> {
  if (!ids.length) return null;
  try {
    const out = new Set<string>();
    for (let i = 0; i < ids.length; i += ID_BATCH) {
      const chunk = ids.slice(i, i + ID_BATCH);
      const rows = await supabaseRowsAll<{
        client_id: string | number | null;
        is_return_lead: boolean | null;
      }>(
        `v_bmby_leads_bucketed?client_id=in.(${chunk.join(",")})` +
          `&select=client_id,is_return_lead`,
        { maxRows: 20000 },
      );
      // Any of a client's leads being flagged makes the person a returner —
      // the flag is about the human, and it is set on the later inquiry.
      for (const r of rows) {
        if (r.is_return_lead === true) out.add(clean(r.client_id));
      }
    }
    return out;
  } catch {
    return null;
  }
}

const clean = (v: unknown) => String(v ?? "").trim();

function describe(slug: string): JourneyChannel {
  return {
    slug,
    label: CHANNEL_LABELS[slug] || slug,
    iconKey: CHANNEL_ICON_KEY[slug] || "",
  };
}

/**
 * Resolve a project to its CRM account names, per platform. Same
 * (project, company) disambiguation every other CRM surface uses — a
 * project name shared by two companies must not hand back the other one's
 * leads.
 *
 * The cell can name BOTH: חמסה/רייסדור reads "bmby, sehel" because its
 * clients live in two systems. So it is parsed rather than compared, and
 * a project on both gets both halves read and merged.
 *
 * Returns null when the project has no CRM cell at all.
 */
async function accountsFor(
  project: string,
  company: string,
): Promise<{ bmby: string[]; sehel: string[]; platform: string } | null> {
  const { headers, rows } = await readKeysCached(driveFolderOwner());
  const iProj = headers.indexOf("פרוייקט");
  const iCo = headers.indexOf("חברה");
  const iCrm = headers.indexOf("CRM");
  const iPlat = headers.indexOf("CRM platform");
  if (iProj < 0 || iCrm < 0) return null;
  for (const r of rows) {
    const cells = r as unknown[];
    if (clean(cells[iProj]) !== project) continue;
    const rc = iCo >= 0 ? clean(cells[iCo]) : "";
    if (rc && company && rc !== company) continue;
    const crmAccount = clean(cells[iCrm]);
    if (!crmAccount) return null;
    const platform = iPlat >= 0 ? clean(cells[iPlat]).toLowerCase() : "";
    const named = platform
      .split(/[,;/|]/)
      .map((s) => s.trim())
      .filter(Boolean);
    // An empty platform cell means BMBY, which is how the rest of the
    // codebase reads it — the column was added after BMBY already was
    // the only CRM.
    const wantsBmby = named.length === 0 || named.includes("bmby");
    const wantsSehel = named.includes("sehel");
    const cands = crmAccountCandidates(crmAccount);
    return {
      bmby: wantsBmby ? cands : [],
      sehel: wantsSehel ? cands : [],
      platform,
    };
  }
  return null;
}

/**
 * The Sehel half.
 *
 * Sehel has no `v_bmby_journey_meetings` equivalent — nobody resolved its
 * touch chain upstream — so this does it here, from the raw table the
 * BMBY view was itself built from. `sehel_touches` carries `is_lead_event`,
 * `source` and `event_at` on 12,985 lead events at 100% coverage, which is
 * everything the resolution needs: order a client's lead events by time,
 * take the first source and the last.
 *
 * THREE THINGS THAT DIFFER FROM BMBY, all of them consequences of the data:
 *
 *  - The unit is the CLIENT, not the lead. `sehel_touches` has no lead id;
 *    a person is a `client_uuid` and their inquiries are events under it.
 *    So a Sehel column counts people who booked, and a BMBY column counts
 *    leads. They are close enough to merge on a project that runs both
 *    (a lead is a person's inquiry) and the label says "לידים" for both,
 *    but the difference is real and this is where it is written down.
 *
 *  - The source is the salesperson's free text — 60 distinct strings for
 *    what is really a dozen channels — so it goes through channelSlug()
 *    (lib/channelIcon.ts), the same rule list the ערוצים table buckets
 *    with. 98.9% of lead events land in a named channel; the rest are a
 *    developer's own name or a campaign code and become "אחר".
 *
 *  - Coverage is partial and the card must say so. Measured across the
 *    whole table: 1,247 meetings sit on 1,000 clients, but only 595 of
 *    those clients have any lead touch recorded at all. The other 405 are
 *    not "people who never changed channel" — they are people we cannot
 *    see, and counting them as the former would understate the movement
 *    this card exists to show. They are returned as `unresolved`.
 */
async function sehelJourney(
  accounts: string[],
  from: string,
  to: string,
): Promise<{ cells: Map<string, number>; unresolved: number } | null> {
  if (!accounts.length) return null;
  // EXACT, matching lib/heldMeetings.ts: `sehel_meetings.project_name`
  // holds a handful of distinct values, none extending another, so a
  // prefix match would buy nothing and open the door that once put one
  // developer's customers on another's page.
  const meetings = await supabaseRowsAll<{ client_uuid: string | null }>(
    `sehel_meetings?or=(${orExactFilter("project_name", accounts)})` +
      `&starts_at=gte.${from}T00:00:00&starts_at=lt.${to}T23:59:59` +
      `&select=client_uuid`,
    { maxRows: 20000 },
  );
  const clients = [...new Set(meetings.map((m) => clean(m.client_uuid)).filter(Boolean))];
  if (!clients.length) return null;

  const first = new Map<string, { at: string; src: string }>();
  const last = new Map<string, { at: string; src: string }>();
  for (let i = 0; i < clients.length; i += ID_BATCH) {
    const chunk = clients.slice(i, i + ID_BATCH);
    const rows = await supabaseRowsAll<{
      client_uuid: string | null;
      event_at: string | null;
      source: string | null;
    }>(
      `sehel_touches?client_uuid=in.(${chunk.map((c) => `"${c.replace(/"/g, "")}"`).join(",")})` +
        `&is_lead_event=is.true&select=client_uuid,event_at,source`,
      { maxRows: 40000 },
    );
    // Min/max by timestamp rather than trusting the order the rows arrive
    // in: `order=` on a batched read orders each batch, not the whole set,
    // and this only needs the two ends.
    for (const r of rows) {
      const c = clean(r.client_uuid);
      const at = clean(r.event_at);
      const src = clean(r.source);
      if (!c || !at || !src) continue;
      const f = first.get(c);
      if (!f || at < f.at) first.set(c, { at, src });
      const l = last.get(c);
      if (!l || at > l.at) last.set(c, { at, src });
    }
  }

  const cells = new Map<string, number>();
  let unresolved = 0;
  for (const c of clients) {
    const f = first.get(c);
    const l = last.get(c);
    if (!f || !l) {
      unresolved++;
      continue;
    }
    const key = `${channelSlug(f.src)}${KEY_SEP}${channelSlug(l.src)}`;
    cells.set(key, (cells.get(key) ?? 0) + 1);
  }
  if (!cells.size) return null;
  return { cells, unresolved };
}


/**
 * The BMBY half. Reads the view that already resolved the chain.
 *
 * Counts DISTINCT leads, not meeting rows: a lead with three coordinations
 * in the window is one person who changed channel once, and counting the
 * row would let the busiest leads set the shape of the card.
 */
async function bmbyJourney(
  accounts: string[],
  from: string,
  to: string,
): Promise<{ cells: Map<string, number>; movedClients: Set<string> } | null> {
  if (!accounts.length) return null;
  const rows = await supabaseRowsAll<Row>(
    `v_bmby_journey_meetings?or=(${orExactFilter("project_he", accounts)})` +
      `&meeting_date=gte.${from}&meeting_date=lte.${to}` +
      `&select=lead_id,client_id,first_lid_channel,last_lid_channel`,
    { maxRows: 20000 },
  );
  if (!rows.length) return null;
  const seen = new Set<string>();
  const cells = new Map<string, number>();
  const movedClients = new Set<string>();
  for (const r of rows) {
    const id = clean(r.lead_id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const f = clean(r.first_lid_channel) || "other";
    const l = clean(r.last_lid_channel) || "other";
    const key = `${f}${KEY_SEP}${l}`;
    cells.set(key, (cells.get(key) ?? 0) + 1);
    const cid = clean(r.client_id);
    if (cid && f !== l) movedClients.add(cid);
  }
  if (!cells.size) return null;
  return { cells, movedClients };
}

export const getLeadJourney = cache(
  async (args: {
    project: string;
    company: string;
    from: string;
    to: string;
  }): Promise<LeadJourney | null> => {
    const project = clean(args.project);
    if (!supabaseConfigured() || !project || !args.from || !args.to) return null;
    try {
      const acct = await accountsFor(project, clean(args.company));
      if (!acct) return null;

      // Both halves in parallel, and a project on both gets both. The
      // counts ADD: חמסה splits its clients between two systems, it does
      // not record each one twice.
      const [bmby, sehel] = await Promise.all([
        bmbyJourney(acct.bmby, args.from, args.to).catch(() => null),
        sehelJourney(acct.sehel, args.from, args.to).catch(() => null),
      ]);
      if (!bmby && !sehel) return null;

      const cells = new Map<string, number>();
      for (const part of [bmby?.cells, sehel?.cells]) {
        if (!part) continue;
        for (const [k, n] of part) cells.set(k, (cells.get(k) ?? 0) + n);
      }
      if (!cells.size) return null;

      const matrix: JourneyCell[] = [];
      const originBy = new Map<string, number>();
      const triggerBy = new Map<string, number>();
      let total = 0;
      let moved = 0;
      for (const [key, count] of cells) {
        const [from, to] = key.split(KEY_SEP);
        matrix.push({ from, to, count });
        originBy.set(from, (originBy.get(from) ?? 0) + count);
        triggerBy.set(to, (triggerBy.get(to) ?? 0) + count);
        total += count;
        if (from !== to) moved += count;
      }

      const toRows = (m: Map<string, number>): JourneyRow[] =>
        [...m.entries()]
          .map(([slug, count]) => ({ slug, count }))
          .sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug));

      const origin = toRows(originBy);
      const trigger = toRows(triggerBy);

      const channels: Record<string, JourneyChannel> = {};
      for (const slug of new Set([...originBy.keys(), ...triggerBy.keys()])) {
        channels[slug] = describe(slug);
      }

      let hot: string | null = null;
      let hotDelta = 0;
      for (const slug of Object.keys(channels)) {
        const d = (triggerBy.get(slug) ?? 0) - (originBy.get(slug) ?? 0);
        if (d > hotDelta) {
          hot = slug;
          hotDelta = d;
        }
      }

      // The returning cross-tab is BMBY-only: `is_return_lead` lives in
      // v_bmby_leads_bucketed and Sehel's tables carry no equivalent. On a
      // project that runs BOTH it is therefore left NULL rather than
      // reported — a count covering half the card, printed as if it
      // covered all of it, is the kind of number this whole card exists to
      // argue against.
      const bmbyOnly = !!bmby && !sehel;
      const returners =
        bmbyOnly && moved && bmby.movedClients.size
          ? await returningClients([...bmby.movedClients])
          : null;
      const returningAmongMoved = returners
        ? [...bmby!.movedClients].filter((c) => returners.has(c)).length
        : null;

      return {
        origin,
        trigger,
        matrix,
        channels,
        total,
        moved,
        hot,
        hotDelta,
        returningAmongMoved,
        unresolved: sehel?.unresolved ?? 0,
        platforms: [bmby ? "bmby" : "", sehel ? "sehel" : ""].filter(
          Boolean,
        ) as ("bmby" | "sehel")[],
      };
    } catch (e) {
      console.warn(
        `[getLeadJourney] failed for "${args.project}": ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return null;
    }
  },
);
