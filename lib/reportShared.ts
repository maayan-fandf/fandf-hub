/**
 * Pure types + math for the NATIVE project report — the in-hub rebuild of
 * the Apps Script dashboard (phase 1: top-funnel + trends). Shared by the
 * server reader (lib/reportData.ts) and the client tab components, so keep
 * this module free of server-only imports.
 *
 * Every formula here mirrors the Apps Script source exactly so the native
 * numbers stay byte-identical with the legacy iframe while both run in
 * parallel: sumAdPlatform (Index.html:7606), kpiAlert (:7833), deltaBadge
 * (:7872), renderFunnelDiagnosis (:7900), the top-funnel derived ratios
 * (:7993). Change them only together with the Apps Script until the
 * legacy report is retired.
 */

export type ReportPlat = "google" | "facebook" | "taboola" | "outbrain";

export const REPORT_PLATS: ReportPlat[] = [
  "google",
  "facebook",
  "taboola",
  "outbrain",
];

export const PLAT_LABELS: Record<ReportPlat, string> = {
  facebook: "Facebook",
  google: "Google",
  taboola: "Taboola",
  outbrain: "Outbrain",
};

/** Darkest→lightest shade ramps — biggest pie slice gets the darkest.
 *  Same palettes as the legacy `_AD_PLATFORM_PIE_PALETTES_`. */
export const PLAT_PALETTES: Record<ReportPlat, string[]> = {
  facebook: ["#1e3a8a", "#1d4ed8", "#2563eb", "#3b82f6", "#60a5fa", "#93c5fd"],
  google: ["#7f1d1d", "#991b1b", "#b91c1c", "#dc2626", "#ef4444", "#f87171"],
  taboola: ["#064e3b", "#047857", "#059669", "#10b981", "#34d399", "#6ee7b7"],
  outbrain: ["#7c2d12", "#9a3412", "#c2410c", "#ea580c", "#f97316", "#fb923c"],
};

/** The mid-tone brand color per platform (used for dots/labels). */
export const PLAT_COLORS: Record<ReportPlat, string> = {
  facebook: "#2563eb",
  google: "#dc2626",
  taboola: "#059669",
  outbrain: "#ea580c",
};

export type PlatCampaign = {
  name: string;
  imp: number;
  clk: number;
  cost: number;
  leads: number;
};

export type PlatTotals = {
  impressions: number;
  clicks: number;
  cost: number;
  /** Google rows sum their leads column here (legacy: out.google.conversions). */
  conversions: number;
  /** FB / Taboola / Outbrain leads (legacy: out.<plat>.leads). */
  leads: number;
  campaigns: PlatCampaign[];
};

export type AdPlatform = Record<ReportPlat, PlatTotals>;

export type DailyPoint = {
  date: string; // YYYY-MM-DD
  cost: number;
  leads: number;
  impressions: number;
  clicks: number;
};

export type SmTotals = {
  impressions: number;
  clicks: number;
  cost: number;
  ctr: number;
  cpc: number;
  /** Google-only ("המרות (Google)" card stays Google-specific). */
  conversions: number;
  /** Facebook-only. */
  fbLeads: number;
  /** Taboola + Outbrain leads folded into funnel ratios. */
  otherLeads: number;
};

export type ReportWindow = { startIso: string; endIso: string };

export type ProjectReportData = {
  project: string;
  slug: string;
  mode: "live" | "month" | "range";
  window: ReportWindow;
  prevWindow: ReportWindow | null;
  adPlatform: AdPlatform;
  prevAdPlatform: AdPlatform | null;
  /** Full unfiltered per-platform daily series (client windows it). */
  daily: Record<ReportPlat, DailyPoint[]>;
  /** ALL CLIENTS per-channel rows for the window mode ([] in range mode). */
  totals: {
    budget: number;
    spend: number;
    leads: number;
    scheduled: number;
    meetings: number;
  } | null;
};

export function emptyPlatTotals(): PlatTotals {
  return {
    impressions: 0,
    clicks: 0,
    cost: 0,
    conversions: 0,
    leads: 0,
    campaigns: [],
  };
}

export function emptyAdPlatform(): AdPlatform {
  return {
    google: emptyPlatTotals(),
    facebook: emptyPlatTotals(),
    taboola: emptyPlatTotals(),
    outbrain: emptyPlatTotals(),
  };
}

/** Legacy `sumAdPlatform` (Index.html:7606). */
export function sumAdPlatform(ap: AdPlatform): SmTotals {
  const g = ap.google;
  const f = ap.facebook;
  const t = ap.taboola;
  const o = ap.outbrain;
  const imp = g.impressions + f.impressions + t.impressions + o.impressions;
  const clk = g.clicks + f.clicks + t.clicks + o.clicks;
  const cost = g.cost + f.cost + t.cost + o.cost;
  return {
    impressions: imp,
    clicks: clk,
    cost,
    ctr: imp > 0 ? clk / imp : 0,
    cpc: clk > 0 ? cost / clk : 0,
    conversions: g.conversions,
    fbLeads: f.leads,
    otherLeads: t.leads + o.leads,
  };
}

/** Paid-ad-attributable leads (NOT the CRM total — see Index.html:7984). */
export function adLeadsOf(sm: SmTotals): number {
  return sm.fbLeads + sm.conversions + sm.otherLeads;
}

export type KpiTone = "" | "red" | "amber" | "green";

/** Legacy `kpiAlert` thresholds (Index.html:7833). Low-volume skips. */
export function kpiAlert(
  metric: string,
  value: number,
  ctx: { impressions: number; clicks: number; fbCost: number; googleCost: number },
): KpiTone {
  if (metric === "ctr" && ctx.impressions > 500) {
    if (value < 0.005) return "red";
    if (value < 0.01) return "amber";
    if (value >= 0.02) return "green";
  }
  if (metric === "clickToLead" && ctx.clicks > 50) {
    if (value === 0) return "red";
    if (value < 0.02) return "amber";
    if (value >= 0.1) return "green";
  }
  if (metric === "impToLead" && ctx.impressions > 5000) {
    if (value === 0) return "red";
    if (value < 0.0005) return "amber";
  }
  if (metric === "fbLeads" && ctx.fbCost > 200) {
    if (value === 0) return "red";
  }
  if (metric === "conversions" && ctx.googleCost > 200) {
    if (value === 0) return "red";
  }
  return "";
}

export type DeltaInfo = {
  /** "none" (·/— under 3% or neutral), "new" (prev=0), "good", "bad". */
  cls: "none" | "new" | "good" | "bad";
  arrow: string;
  /** "+12%" style text ("" for the new/none-both-zero cases). */
  text: string;
  prev: number;
};

/** Legacy `deltaBadge` semantics (Index.html:7872). Null = no previous data. */
export function deltaInfo(
  current: number,
  previous: number | null | undefined,
  goodDir: "up" | "down" | "neutral",
): DeltaInfo | null {
  if (previous == null) return null;
  const prev = Number(previous) || 0;
  const cur = Number(current) || 0;
  if (prev === 0 && cur === 0)
    return { cls: "none", arrow: "", text: "—", prev };
  if (prev === 0) return { cls: "new", arrow: "", text: "חדש", prev };
  const pct = (cur - prev) / prev;
  const arrow = cur > prev ? "▲" : cur < prev ? "▼" : "•";
  let cls: DeltaInfo["cls"];
  if (goodDir === "neutral" || Math.abs(pct) < 0.03) cls = "none";
  else {
    const isBetter = goodDir === "down" ? cur < prev : cur > prev;
    cls = isBetter ? "good" : "bad";
  }
  return {
    cls,
    arrow,
    text: (pct >= 0 ? "+" : "") + (pct * 100).toFixed(0) + "%",
    prev,
  };
}

export type FunnelDx = {
  kind: "nodata" | "site" | "quality" | "ads" | "mixed" | "ok";
  icon: string;
  /** Hebrew verdict — trusted, self-authored HTML (only <b> tags). */
  verdictHtml: string;
  /** Platforms with spend/impressions but zero clicks (tracking gap). */
  integrity: string[];
  ctrNow: number;
  cvrNow: number;
  ctrDelta: number;
  cvrDelta: number;
  ctrState: "down" | "up" | "stable";
  cvrState: "down" | "up" | "stable";
};

/**
 * Legacy `renderFunnelDiagnosis` (Index.html:7900) — CTR (ad) vs
 * click→lead CVR (site/traffic) current-vs-previous, naming the culprit.
 * Returns null when there is no previous window to compare against.
 */
export function diagnoseTopFunnel(
  sm: SmTotals,
  prevSm: SmTotals | null,
  ap: AdPlatform,
  prev: AdPlatform | null,
): FunnelDx | null {
  if (!prevSm) return null;
  const MIN_CLK = 30,
    MIN_IMP = 1000,
    TH = 0.15;
  const adLeads = adLeadsOf(sm);
  const prevAdLeads = adLeadsOf(prevSm);
  const cvrNow = sm.clicks > 0 ? Math.min(adLeads / sm.clicks, 1) : 0;
  const cvrPrev =
    prevSm.clicks > 0 ? Math.min(prevAdLeads / prevSm.clicks, 1) : 0;
  const ctrNow = sm.ctr || 0,
    ctrPrev = prevSm.ctr || 0;
  const rel = (n: number, p: number) => (p > 0 ? (n - p) / p : n > 0 ? 1 : 0);

  const plats: { name: string; now: PlatTotals; prev: PlatTotals; leadKey: "leads" | "conversions" }[] = [
    { name: "Facebook", now: ap.facebook, prev: prev?.facebook ?? emptyPlatTotals(), leadKey: "leads" },
    { name: "Google", now: ap.google, prev: prev?.google ?? emptyPlatTotals(), leadKey: "conversions" },
    { name: "Taboola", now: ap.taboola, prev: prev?.taboola ?? emptyPlatTotals(), leadKey: "leads" },
    { name: "Outbrain", now: ap.outbrain, prev: prev?.outbrain ?? emptyPlatTotals(), leadKey: "leads" },
  ];
  const integrity: string[] = [];
  const declinedCvr: string[] = [];
  let activeCvr = 0;
  for (const pl of plats) {
    const cN = pl.now.clicks,
      cP = pl.prev.clicks;
    if ((pl.now.cost > 0 || pl.now.impressions > MIN_IMP) && cN === 0)
      integrity.push(pl.name);
    if (cN >= MIN_CLK && cP >= MIN_CLK) {
      activeCvr++;
      const cvN = Math.min(pl.now[pl.leadKey] / cN, 1);
      const cvP = Math.min(pl.prev[pl.leadKey] / cP, 1);
      if (rel(cvN, cvP) <= -TH) declinedCvr.push(pl.name);
    }
  }

  if (sm.clicks < MIN_CLK || sm.impressions < MIN_IMP || prevSm.clicks < MIN_CLK) {
    return {
      kind: "nodata",
      icon: "🔬",
      verdictHtml: `אין מספיק נפח להשוואה אמינה בתקופה הזו (צריך ≥${MIN_CLK} קליקים בשתי התקופות).`,
      integrity,
      ctrNow,
      cvrNow,
      ctrDelta: 0,
      cvrDelta: 0,
      ctrState: "stable",
      cvrState: "stable",
    };
  }

  const ctrD = rel(ctrNow, ctrPrev),
    cvrD = rel(cvrNow, cvrPrev);
  const cls = (d: number): "down" | "up" | "stable" =>
    d <= -TH ? "down" : d >= TH ? "up" : "stable";
  const ctrS = cls(ctrD),
    cvrS = cls(cvrD);

  let kind: FunnelDx["kind"], icon: string, verdictHtml: string;
  if (cvrS === "down" && ctrS !== "down") {
    if (declinedCvr.length >= 2) {
      kind = "site";
      icon = "🌐";
      verdictHtml = `כנראה בעיה ב<b>אתר / דף הנחיתה</b> — ה-CVR ירד <b>בכל הפלטפורמות</b> (${declinedCvr.join(", ")}) בעוד ה-CTR יציב. דף הנחיתה הוא המכנה המשותף — בדקו שינוי בעמוד, תקלת טופס, מהירות טעינה, התאמת הצעה.`;
    } else if (declinedCvr.length === 1 && activeCvr >= 2) {
      kind = "quality";
      icon = "🎯";
      verdictHtml = `ירידת CVR ב-<b>${declinedCvr[0]}</b> בלבד (שאר הפלטפורמות יציבות) — כנראה <b>איכות תנועה/קהל</b> בפלטפורמה הזו, לא האתר.`;
    } else {
      kind = "site";
      icon = "🌐";
      verdictHtml = `ה-CVR ירד וה-CTR יציב — כנראה <b>האתר/דף הנחיתה</b> או איכות התנועה. (פלטפורמה פעילה אחת — לא ניתן לבודד לחלוטין.) בדקו את דף הנחיתה.`;
    }
  } else if (ctrS === "down" && cvrS !== "down") {
    kind = "ads";
    icon = "🎯";
    verdictHtml = `כנראה בעיה ב<b>מודעות</b> (קריאייטיב/קהל) — ה-CTR ירד וה-CVR יציב. בדקו עייפות קריאייטיב + רענון, ותדירות/קהל.`;
  } else if (ctrS === "down" && cvrS === "down") {
    kind = "mixed";
    icon = "⚠️";
    verdictHtml = `ירידה <b>רוחבית</b> — גם ה-CTR וגם ה-CVR ירדו. בדקו הצעה/מסר, עונתיות, או <b>תקלת מעקב המרות</b> (לא רק מודעה או אתר).`;
  } else if (ctrS === "up" && cvrS === "down") {
    kind = "quality";
    icon = "ℹ️";
    verdictHtml = `ה-CTR <b>עלה</b> אך ה-CVR <b>ירד</b> — המודעות מביאות תנועה רחבה/זולה אך פחות איכותית. בדקו התאמת קהל/הצעה.`;
  } else {
    kind = "ok";
    icon = "✅";
    verdictHtml = `המשפך <b>יציב</b> — אין ירידה משמעותית ב-CTR או ב-CVR לעומת התקופה הקודמת.`;
  }

  return {
    kind,
    icon,
    verdictHtml,
    integrity,
    ctrNow,
    cvrNow,
    ctrDelta: ctrD,
    cvrDelta: cvrD,
    ctrState: ctrS,
    cvrState: cvrS,
  };
}

/* ------------------------------ formatters ------------------------------ */

export const fmtInt = (n: number): string =>
  new Intl.NumberFormat("he-IL", { maximumFractionDigits: 0 }).format(
    Math.round(n || 0),
  );

export const fmtILS = (n: number): string => `₪${fmtInt(n)}`;

/** Two-decimal percent, e.g. 0.0123 → "1.23%". */
export const fmtPct2 = (n: number): string => `${((n || 0) * 100).toFixed(2)}%`;

export const fmtDateHe = (iso: string): string => {
  if (!iso) return "";
  const p = iso.split("-");
  return `${p[2]}/${p[1]}/${p[0]}`;
};
