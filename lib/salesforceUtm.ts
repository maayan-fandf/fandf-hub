/**
 * Salesforce UTM enrichment.
 *
 * Salesforce's own CRM tab carries NO usable utm_* fields, so the UTM drill
 * BMBY/Sehel get (placement / audience / creative / keyword) needs a second
 * source: the Shikun&Binui landing-page capture spreadsheet
 * (`Shikun-Binui-f&f-Leads`), one tab per project, one row per submitted lead.
 *
 * Join key = PHONE. The capture sheet stores a bare local number
 * ("546729116") while Salesforce stores it zero-prefixed ("0546729116"), so
 * both sides are canonicalized to the 9-digit local form.
 *
 * The UTM shape matches BMBY's exactly, which is why the whole existing
 * `fbBreakdown` panel + spend join work unchanged:
 *   utm_medium   = placement   ("Facebook_Mobile_Feed" / "Instagram_Stories")
 *   utm_term     = audience    ("RM+ENG")   — or the KEYWORD on google rows
 *   utm_content  = creative    ("2026-07-06d")
 *   utm_campaign = readable    ("Shbn_eastern_investors_WL_2026-07-08_FB")
 *                  → joins the fb-ads Sheet by campaign name for spend.
 *
 * Coverage is uneven per project (see SALESFORCE_UTM_COVERAGE in the brief):
 * some tabs tag campaign-only, so the creative table can be sparse while
 * placement/audience are rich. Everything degrades to "no panel" rather than
 * wrong numbers.
 */
import { cache } from "react";
import { sheetsClient } from "@/lib/sa";

const SF_UTM_SHEET_ID =
  process.env.SF_UTM_SHEET_ID || "14DGykTtQ88q6laq2O9mEojh6LY1g4qV3nddRqeoTWE8";

/** NORMALIZED utm for one lead. We deliberately do NOT expose raw
 *  medium/term/content — see `classifyUtm` for why the columns can't be
 *  trusted. */
export type SfUtm = {
  source: string;
  campaign: string;
  /** e.g. "Facebook Mobile Feed" */
  placement: string;
  /** e.g. "RM+ENG" */
  audience: string;
  /** e.g. "2026-07-06d" */
  creative: string;
};

/* ── Column-trust problem ──────────────────────────────────────────────
 * The four landing pages tag INCONSISTENTLY (measured 2026-07-13):
 *   eastern   ✅ medium=placement, term=audience, content=creative (17/17)
 *   golomb    ⚠️ medium ↔ content SWAPPED on 18/25 rows
 *   essence   ⚠️ only 2 rows carry medium/term/content at all
 *   benshemen ⚠️ Meta's raw NUMERIC ids (campaign/term/content), medium="paid"
 * Reading by header would file creatives under "placement" and vice-versa.
 *
 * The VALUES are self-identifying though — a placement always looks like
 * `Facebook_Mobile_Feed`/`Instagram_Stories`/`an`, a creative always looks like
 * `2026-06-30G`. So classify by SHAPE and ignore which column it landed in;
 * numeric ids are dropped (unusable as a label and they can't join the
 * name-keyed fb-ads spend sheet). */
const isPlacementVal = (v: string) =>
  /^(an|audience_network)$/i.test(v) ||
  /facebook_|instagram_|messenger_|_feed|_stories|_reels|_video/i.test(v);
const isCreativeVal = (v: string) => /^\d{4}-\d{2}-\d{2}/.test(v);
const isNumericId = (v: string) => /^\d{8,}$/.test(v);

/** Assign the three loosely-tagged values to their real dimensions by shape. */
function classifyUtm(vals: string[]): {
  placement: string;
  audience: string;
  creative: string;
} {
  let placement = "";
  let creative = "";
  const rest: string[] = [];
  for (const raw of vals) {
    const v = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (!v || isNumericId(v)) continue; // numeric ids: unusable
    if (!placement && isPlacementVal(v)) placement = v.replace(/_/g, " ");
    else if (!creative && isCreativeVal(v)) creative = v;
    else rest.push(v);
  }
  // Whatever isn't a placement or a creative is the audience ("RM+ENG",
  // "ll leads", "Real estate investing") — skip generic mediums like "paid".
  const audience = rest.find((v) => !/^(paid|cpc|organic|none|referral)$/i.test(v)) ?? "";
  return { placement, audience, creative };
}

/** Israeli mobile → canonical 9-digit local (drops non-digits, a 972 country
 *  code, and the leading 0) so the capture sheet and Salesforce agree. */
export function normPhone(s: unknown): string {
  let d = String(s ?? "").replace(/\D/g, "");
  if (d.startsWith("972")) d = d.slice(3);
  if (d.startsWith("0")) d = d.slice(1);
  return d.length >= 9 ? d.slice(-9) : "";
}

/** Lowercased email, or "" for blanks and Salesforce's "[לא סופק]" placeholder
 *  (anything without an @ is not a usable join key). */
export function normEmail(s: unknown): string {
  const v = String(s ?? "").trim().toLowerCase();
  return v.includes("@") ? v : "";
}

/** Both join keys for the capture sheet. A lead is matched on PHONE first and
 *  EMAIL as a fallback — either side can be missing/malformed, and matching on
 *  only one of them silently drops those leads. */
export type SfUtmIndex = {
  byPhone: Map<string, SfUtm>;
  byEmail: Map<string, SfUtm>;
};

/** Resolve a Salesforce lead's UTM: phone first, then email. */
export function lookupSfUtm(
  idx: SfUtmIndex,
  phone: unknown,
  email: unknown,
): SfUtm | undefined {
  const p = normPhone(phone);
  if (p) {
    const hit = idx.byPhone.get(p);
    if (hit) return hit;
  }
  const e = normEmail(email);
  if (e) return idx.byEmail.get(e);
  return undefined;
}

/**
 * Index the capture sheet by BOTH phone and email, across every project tab
 * (first row for a given key wins). Returns EMPTY indexes on any failure — a
 * renamed/moved sheet must never break the Salesforce funnel, it just means no
 * UTM panel.
 */
export const readSalesforceUtmIndex = cache(
  async (subjectEmail: string): Promise<SfUtmIndex> => {
    const byPhone = new Map<string, SfUtm>();
    const byEmail = new Map<string, SfUtm>();
    const out: SfUtmIndex = { byPhone, byEmail };
    try {
      const sheets = sheetsClient(subjectEmail);
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: SF_UTM_SHEET_ID,
        fields: "sheets.properties.title",
      });
      const tabs = (meta.data.sheets ?? [])
        .map((s) => s.properties?.title)
        .filter((t): t is string => !!t);
      if (!tabs.length) return out;
      const res = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: SF_UTM_SHEET_ID,
        ranges: tabs.map((t) => `${t}!A:S`),
        valueRenderOption: "UNFORMATTED_VALUE",
        dateTimeRenderOption: "FORMATTED_STRING",
      });
      for (const vr of res.data.valueRanges ?? []) {
        const rows = (vr.values ?? []) as unknown[][];
        if (rows.length < 2) continue;
        const h = (rows[0] as unknown[]).map((x) => String(x ?? "").trim());
        const iPh = h.indexOf("phone");
        const iEm = h.indexOf("email");
        if (iPh < 0 && iEm < 0) continue;
        const iSrc = h.indexOf("utm_source");
        const iCamp = h.indexOf("utm_campaign");
        const iMed = h.indexOf("utm_medium");
        const iTerm = h.indexOf("utm_term");
        const iCont = h.indexOf("utm_content");
        const val = (r: unknown[], i: number) =>
          i >= 0 ? String(r[i] ?? "").trim() : "";
        for (const r of rows.slice(1)) {
          const ph = iPh >= 0 ? normPhone(r[iPh]) : "";
          const em = iEm >= 0 ? normEmail(r[iEm]) : "";
          if (!ph && !em) continue;
          // Shape-classify the three loosely-tagged columns (they're swapped on
          // some tabs) instead of trusting their headers.
          const { placement, audience, creative } = classifyUtm([
            val(r, iMed),
            val(r, iTerm),
            val(r, iCont),
          ]);
          const rec: SfUtm = {
            source: val(r, iSrc),
            campaign: val(r, iCamp),
            placement,
            audience,
            creative,
          };
          // Index under BOTH keys (first row for a key wins) so a lead missing
          // one of them on either side still resolves.
          if (ph && !byPhone.has(ph)) byPhone.set(ph, rec);
          if (em && !byEmail.has(em)) byEmail.set(em, rec);
        }
      }
    } catch {
      /* sheet missing / renamed / no access → no UTM drill, funnel unaffected */
    }
    return out;
  },
);
