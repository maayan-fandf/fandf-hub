import { cache } from "react";
import { sheetsClient, driveFolderOwner } from "@/lib/sa";

/**
 * Media-campaign workbook reader for NON-real-estate clients.
 *
 * Real-estate projects report through the CRM funnel (leads → תואמו →
 * פגישות → חוזים) because that's what the business is. A client like
 * עיריית תל אביב has no funnel at all — the product is an app, so the
 * campaign is judged on reach and installs: חשיפות → הקלקות לחנות →
 * צפיות → התקנות, against a flight budget. `lib/crmData.ts` can't be
 * bent into that shape, so this is its sibling rather than a variant.
 *
 * The source is a hand-maintained workbook the media team keeps per
 * client, NOT a warehouse export. Two tabs matter:
 *
 *   <project tab>  — actuals, one repeating block per campaign flight
 *   פריסת מדיה     — the forward plan (forecast) blocks
 *
 * An actuals block looks like this (col A is always blank — the sheet
 * is indented one column):
 *
 *   B              C
 *   קמפיין         <flight name>          ← h-9
 *   תקציב כולל דמ"ט <gross>  עליה  <from>  ← h-8
 *   תקציב מדיה      <net>    ירידה <to>    ← h-7
 *   מחולק          <allocated> <brief url> ← h-6
 *   דמי ניהול       <fee pct>              ← h-5
 *   פריסה ובריף                            ← h-4
 *   (blank) (blank)                        ← h-3, h-2
 *   נתונים בפועל                            ← h-1
 *   ערוץ | פלטפורמה | שם קמפיין | ...      ← h   (the anchor)
 *   <channel rows…>
 *   Total
 *
 * We anchor on the header row rather than the Hebrew title because
 * column G of that row is the ASCII literal "cost" — the one cell in
 * the block that can't be reworded by an editor without also breaking
 * their own formulas.
 */

/** Per-project workbook registry.
 *
 *  Deliberately code-side rather than a new `Keys` column: adding a
 *  column means an edit to the shared production Keys sheet that every
 *  other reader would then have to tolerate, for what is (today) one
 *  client. Env override first so the id can be repointed without a
 *  deploy — same shape as CRM_SHEET_ID in lib/crmData.ts. Move this to
 *  Keys once a third client needs it. */
const MEDIA_WORKBOOKS: Record<
  string,
  { spreadsheetId: string; actualsTab: string; planTab: string }
> = {
  "דיגיתל שלי": {
    spreadsheetId:
      process.env.MEDIA_SHEET_ID_DIGITEL ||
      "1ta4pB6wIetA-F16Af-DDC9Qci73l41wV9MPQ1UgFmCs",
    actualsTab: "דיגיתל שלי",
    planTab: "פריסת מדיה",
  },
};

/** True when this project has a media workbook wired up. Cheap enough
 *  to call from a render path — no I/O. */
export function hasMediaWorkbook(project: string): boolean {
  return Boolean(MEDIA_WORKBOOKS[String(project ?? "").trim()]);
}

export type MediaChannelRow = {
  /** ערוץ — Meta Ads / Google ads / DV360 / יוטיוב / מוביט / Joka. */
  channel: string;
  /** פלטפורמה — Android / ios / Android+ios / DV360 / … */
  platform: string;
  /** שם קמפיין as it appears in the ad platform. */
  campaignName: string;
  /** הערות — usually the objective (התקנות / צפיות / חשיפות / הקלקות). */
  note: string;
  budget: number | null;
  cost: number | null;
  impressions: number | null;
  /** הקלקות לחנות — store clicks. */
  clicks: number | null;
  views: number | null;
  fullViews: number | null;
  installs: number | null;
  reactions: number | null;
  shares: number | null;
};

export type MediaCampaign = {
  name: string;
  /** עלייה / ירידה — flight start and end, ISO. */
  from: string;
  to: string;
  /** תקציב כולל דמ"ט — gross, including the management fee. */
  grossBudget: number | null;
  /** תקציב מדיה — net media budget as typed in the block header. Often
   *  stale relative to the channel rows; see `allocated`. */
  netBudget: number | null;
  /** דמי ניהול, as a fraction (0.12). */
  mgmtFeePct: number | null;
  briefUrl: string;
  channels: MediaChannelRow[];
  /** Sum of the channel rows' budgets. This — not `netBudget` — is the
   *  number utilisation is measured against: the block header is edited
   *  by hand at brief time and several blocks were never corrected when
   *  the plan changed (the launch block reads 55,000 against 154,199 of
   *  actual channel allocation). The channel rows are what the media
   *  team maintains per flight, so they win. */
  allocated: number;
  spent: number;
  impressions: number;
  clicks: number;
  views: number;
  fullViews: number;
  installs: number;
  reactions: number;
  shares: number;
  /** Channels holding an allocation that never recorded a shekel of
   *  spend. Almost always an import gap rather than a real underspend —
   *  worth showing, because it drags reported utilisation down. */
  unfundedChannels: string[];
  /** 1-based row of the block's header, for a deep link into the sheet. */
  sheetRow: number;
};

export type MediaPlanRow = {
  channel: string;
  grossBudget: number | null;
  impressions: number | null;
  clicks: number | null;
  results: number | null;
  netMedia: number | null;
};

export type MediaPlanBlock = {
  title: string;
  from: string;
  to: string;
  rows: MediaPlanRow[];
  grossBudget: number;
  impressions: number;
  clicks: number;
  results: number;
};

export type MediaWorkbook = {
  campaigns: MediaCampaign[];
  plans: MediaPlanBlock[];
  sheetUrl: string;
};

/** Sheet numeric. UNFORMATTED_VALUE returns real numbers, but a cell
 *  carrying a broken formula comes back as its error TEXT — this
 *  workbook is full of "#REF! (Reference does not exist.)" and
 *  "#DIV/0! (…)" in the derived columns. Treat every error as absent
 *  rather than letting `Number()` turn it into NaN downstream. */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v ?? "").trim();
  if (!s || s.startsWith("#")) return null;
  const n = Number(s.replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Sheet text, whitespace-normalised. The NBSP collapse is load-bearing,
 *  not hygiene: one "Google ads" cell is typed with U+00A0 instead of a
 *  space, so without this the channel rollup keys on two strings that
 *  look identical and reports Google twice at half its real spend. Same
 *  normalisation lib/keys.ts applies to Keys headers, for the same
 *  reason — hand-edited cells carry invisible characters. */
function str(v: unknown): string {
  const s = String(v ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return s.startsWith("#") ? "" : s;
}

/** Column offsets inside an actuals block's header row. */
const C = {
  channel: 1,
  platform: 2,
  campaignName: 3,
  note: 4,
  budget: 5,
  cost: 6,
  impressions: 9,
  clicks: 10,
  views: 11,
  fullViews: 12,
  installs: 13,
  reactions: 15,
  shares: 16,
  from: 22,
  to: 23,
} as const;

function parseActuals(rows: unknown[][]): MediaCampaign[] {
  const out: MediaCampaign[] = [];
  for (let h = 9; h < rows.length; h++) {
    if (str(rows[h]?.[C.cost]) !== "cost") continue;

    const head = (offset: number, col: number) => rows[h - offset]?.[col];
    const channels: MediaChannelRow[] = [];
    let from = "";
    let to = "";

    for (let r = h + 1; r < rows.length; r++) {
      const channel = str(rows[r]?.[C.channel]);
      // A blank ערוץ ends the block; the sheet's own Total row is
      // recomputed below rather than trusted (its CVR/CPR cells are
      // usually #REF!, and its date cells occasionally carry the
      // PREVIOUS flight's dates — see the חופים block).
      if (!channel) break;
      if (channel === "Total") {
        from = from || str(rows[r]?.[C.from]);
        to = to || str(rows[r]?.[C.to]);
        break;
      }
      // Flight dates repeat on every channel row; first non-empty wins.
      from = from || str(rows[r]?.[C.from]);
      to = to || str(rows[r]?.[C.to]);
      channels.push({
        channel,
        platform: str(rows[r]?.[C.platform]),
        campaignName: str(rows[r]?.[C.campaignName]),
        note: str(rows[r]?.[C.note]),
        budget: num(rows[r]?.[C.budget]),
        cost: num(rows[r]?.[C.cost]),
        impressions: num(rows[r]?.[C.impressions]),
        clicks: num(rows[r]?.[C.clicks]),
        views: num(rows[r]?.[C.views]),
        fullViews: num(rows[r]?.[C.fullViews]),
        installs: num(rows[r]?.[C.installs]),
        reactions: num(rows[r]?.[C.reactions]),
        shares: num(rows[r]?.[C.shares]),
      });
    }

    const name = str(head(9, 2));
    if (!name || !channels.length) continue;

    const sum = (pick: (c: MediaChannelRow) => number | null): number =>
      channels.reduce((a, c) => a + (pick(c) ?? 0), 0);

    out.push({
      name,
      from: from || str(head(8, 4)),
      to: to || str(head(7, 4)),
      grossBudget: num(head(8, 2)),
      netBudget: num(head(7, 2)),
      mgmtFeePct: num(head(5, 2)),
      briefUrl: /^https?:\/\//.test(str(head(6, 3))) ? str(head(6, 3)) : "",
      channels,
      allocated: sum((c) => c.budget),
      spent: sum((c) => c.cost),
      impressions: sum((c) => c.impressions),
      clicks: sum((c) => c.clicks),
      views: sum((c) => c.views),
      fullViews: sum((c) => c.fullViews),
      installs: sum((c) => c.installs),
      reactions: sum((c) => c.reactions),
      shares: sum((c) => c.shares),
      unfundedChannels: channels
        .filter((c) => (c.budget ?? 0) > 0 && !(c.cost ?? 0))
        .map((c) => c.channel),
      sheetRow: h + 1,
    });
  }
  return out;
}

/** Plan-block column offsets. Anchored on col G === "CPA". */
const P = {
  channel: 1,
  grossBudget: 2,
  impressions: 3,
  clicks: 4,
  results: 5,
  cpa: 6,
  netMedia: 11,
} as const;

function parsePlan(rows: unknown[][]): MediaPlanBlock[] {
  const out: MediaPlanBlock[] = [];
  for (let h = 0; h < rows.length; h++) {
    if (str(rows[h]?.[P.cpa]) !== "CPA") continue;

    // Title + flight dates sit in the 1-3 rows above the header. The
    // shape varies (the חירום block has no dates at all), so scan up
    // rather than assuming a fixed offset.
    let title = "";
    let from = "";
    let to = "";
    for (let k = Math.max(0, h - 3); k < h; k++) {
      const label = str(rows[k]?.[1]);
      const date = str(rows[k]?.[3]);
      if (!title && label) title = label;
      if (date && !from) from = date;
      else if (date && !to) to = date;
    }

    const rowsOut: MediaPlanRow[] = [];
    for (let r = h + 1; r < rows.length; r++) {
      const channel = str(rows[r]?.[P.channel]);
      if (!channel) break;
      if (channel === "Total") break;
      rowsOut.push({
        channel,
        grossBudget: num(rows[r]?.[P.grossBudget]),
        impressions: num(rows[r]?.[P.impressions]),
        clicks: num(rows[r]?.[P.clicks]),
        results: num(rows[r]?.[P.results]),
        netMedia: num(rows[r]?.[P.netMedia]),
      });
    }
    if (!title || !rowsOut.length) continue;

    const sum = (pick: (r: MediaPlanRow) => number | null): number =>
      rowsOut.reduce((a, r) => a + (pick(r) ?? 0), 0);

    out.push({
      title,
      from,
      to,
      rows: rowsOut,
      grossBudget: sum((r) => r.grossBudget),
      // Impressions/clicks/results are per-channel forecasts, so they
      // genuinely add up — unlike the sheet's own Total row, which
      // copies the largest channel instead of summing.
      impressions: sum((r) => r.impressions),
      clicks: sum((r) => r.clicks),
      results: sum((r) => r.results),
    });
  }
  return out;
}

/** Per-request dedup: the rail renders the actuals section and the plan
 *  section from the same fetch. */
export const getMediaWorkbook = cache(
  async (project: string): Promise<MediaWorkbook | null> => {
    const cfg = MEDIA_WORKBOOKS[String(project ?? "").trim()];
    if (!cfg) return null;

    const sheets = sheetsClient(driveFolderOwner());
    const res = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: cfg.spreadsheetId,
      ranges: [`'${cfg.actualsTab}'!A1:AH400`, `'${cfg.planTab}'!A1:N80`],
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    });
    const [actuals, plan] = res.data.valueRanges ?? [];
    const campaigns = parseActuals((actuals?.values ?? []) as unknown[][]);
    const plans = parsePlan((plan?.values ?? []) as unknown[][]);
    if (!campaigns.length && !plans.length) return null;

    return {
      // Newest flight first — the client cares about what just ran.
      campaigns: campaigns.sort((a, b) => (a.from < b.from ? 1 : -1)),
      plans,
      sheetUrl: `https://docs.google.com/spreadsheets/d/${cfg.spreadsheetId}/edit`,
    };
  },
);

/* ── Derived metrics ──────────────────────────────────────────────
   Always recomputed from the base counters, never read from the
   sheet's own CTR/CPC/CPM/CVR columns: those are formulas over cells
   that in several blocks resolve to #REF!/#DIV/0!, and the Total row
   averages them rather than recomputing from the sums. Returning null
   for an undefined ratio keeps "no data" distinct from a real zero. */

export function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}
/** Cost per 1,000 impressions. */
export function cpm(cost: number, impressions: number): number | null {
  const r = ratio(cost, impressions);
  return r === null ? null : r * 1000;
}
