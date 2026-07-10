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

export type ReportSubCampaign = {
  name: string;
  spend: number;
  budget: number;
  leads: number;
  scheduled: number;
  meetings: number;
};

/** One row of the ערוצים tab — an ALL CLIENTS channel row enriched with
 *  platform attribution + pacing inputs (legacy `p.channels[i]`). */
export type ReportChannel = {
  channel: string;
  /** classifyChannel bucket ("google"/"facebook"/… or "other"). */
  platform: string;
  budget: number;
  spend: number;
  leads: number;
  scheduled: number;
  meetings: number;
  /** Sheet קצב יומי — the required daily budget ((G−H)/days-left). */
  dailyRate: number;
  startIso: string;
  endIso: string;
  costPerLead: number;
  costPerScheduled: number;
  costPerMeeting: number;
  subCampaigns: ReportSubCampaign[];
  /** Σ ACTIVE matched platform campaigns' configured daily budgets;
   *  null when the channel has no סוג tokens / no campaign matched. */
  configuredDaily: number | null;
  /** Live/paused dot (legacy c.campaignStatus). */
  campaignStatus: "none" | "active" | "paused" | "mixed";
  /** Platform-level trailing-7-day average daily spend — attached only
   *  when this row is its platform's ONLY channel (else the platform
   *  average would be meaningless per-row). */
  avg7d: number | null;
};

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
  /** ALL CLIENTS channel rows enriched for the ערוצים tab (empty in
   *  range mode — the legacy pro-rating path isn't ported yet). */
  channels: ReportChannel[];
  /** קריאייטיבים tab data (null when the creative sheet has nothing
   *  for the project or the fetch failed — the tab shows an empty note). */
  creatives: ReportCreatives | null;
  /** Company (Keys חברה) — for the header tag. */
  company: string;
  /** Landing page URL string (may hold several space/comma-separated). */
  landingUrl: string;
  /** Budget-pacing badge + bars (null in range mode). */
  pacing: ReportPacing | null;
  /** End-of-period forecast strip (live mode only; null otherwise). */
  forecast: ReportForecast | null;
  /** Period-over-period anomaly chips. */
  anomalies: ReportAnomaly[];
  /** Previous-month funnel (day-ratio-scaled) — feeds the util delta. */
  prevFunnel: PrevFunnel | null;
  /** ALL CLIENTS per-channel rows for the window mode ([] in range mode). */
  totals: {
    budget: number;
    spend: number;
    leads: number;
    relevant: number;
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

/** Cost-per-outcome tone for the funnel-flow cards (Index.html:7856):
 *  costPerScheduled ≤2000 green / ≤3000 amber / else red;
 *  costPerMeeting ≤5000 / ≤9000 / else red. Value 0 → no tone. */
export function costPerTone(
  metric: "costPerScheduled" | "costPerMeeting",
  value: number,
): KpiTone {
  if (!value || value <= 0) return "";
  if (metric === "costPerScheduled")
    return value <= 2000 ? "green" : value <= 3000 ? "amber" : "red";
  return value <= 5000 ? "green" : value <= 9000 ? "amber" : "red";
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

/* ------------------------------ header math ------------------------------ */

export type ReportPacing = {
  cls: "green" | "yellow" | "red" | "neutral";
  label: string;
  detail: string;
  spendPct: number;
  dayPct: number;
};

/** Legacy computePacing (Index.html:4387). `todayIso` = Asia/Jerusalem
 *  day, injected so server + client agree. */
export function computePacing(
  totals: { budget: number; spend: number },
  window: ReportWindow,
  todayIso: string,
): ReportPacing {
  if (!totals.budget)
    return { cls: "neutral", label: "אין תקציב", detail: "", spendPct: 0, dayPct: 0 };
  const spendPct = (totals.spend / totals.budget) * 100;
  let dayPct: number | null = null;
  if (window.startIso && window.endIso) {
    const start = Date.parse(window.startIso);
    const end = Date.parse(window.endIso);
    const today = Date.parse(todayIso);
    const total = end - start;
    if (total > 0)
      dayPct = Math.max(0, Math.min(100, ((today - start) / total) * 100));
  }
  if (dayPct === null)
    return { cls: "neutral", label: "תאריכים חסרים", detail: "", spendPct, dayPct: 0 };
  if (dayPct === 0)
    return { cls: "neutral", label: "טרם החל", detail: "", spendPct, dayPct };
  const ratio = spendPct / dayPct;
  const detail = `תקציב ${Math.round(spendPct)}% · ימים ${Math.round(dayPct)}%`;
  if (ratio >= 0.9 && ratio <= 1.1)
    return { cls: "green", label: "בקצב תקין", detail, spendPct, dayPct };
  if (ratio >= 0.7 && ratio <= 1.3)
    return { cls: "yellow", label: "יש לבדוק", detail, spendPct, dayPct };
  if (ratio < 0.7)
    return { cls: "red", label: "מתחת לקצב", detail, spendPct, dayPct };
  return { cls: "red", label: "מעל הקצב", detail, spendPct, dayPct };
}

/** One aggregated calendar-month row (from ALL CLIENTS חודשי rows). */
export type MonthlyRow = {
  month: string; // YYYY-MM
  spend: number;
  leads: number;
  scheduled: number;
  meetings: number;
  budget: number;
};

export type ReportForecast = {
  spend: number;
  leads: number;
  scheduled: number;
  meetings: number;
  budget: number;
  daysLeft: number;
};

const FORECAST_METRICS = ["spend", "leads", "scheduled", "meetings"] as const;
type ForecastMetric = (typeof FORECAST_METRICS)[number];

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Legacy computeForecast (Index.html:4301) + its projection primitives
 * (buildProjectionPrimitives) — projected end-of-period spend/leads/
 * scheduled/meetings by segment-summing every calendar month in the
 * window: past = actuals, current = pace projection, future = median
 * baseline (or planned budget for spend). null when < 10% elapsed / not
 * started / finished / no dates. `todayIso` = Asia/Jerusalem day.
 */
export function computeForecast(
  window: ReportWindow,
  monthly: MonthlyRow[],
  budgetTotal: number,
  totals: { spend: number; leads: number; scheduled: number; meetings: number },
  todayIso: string,
): ReportForecast | null {
  if (!window.startIso || !window.endIso) return null;
  const start = Date.parse(`${window.startIso}T00:00:00`);
  const end = Date.parse(`${window.endIso}T00:00:00`);
  const today = Date.parse(`${todayIso}T00:00:00`);
  const total = end - start;
  if (total <= 0) return null;
  const elapsed = today - start;
  if (elapsed <= 0 || elapsed >= total) return null;
  const pct = elapsed / total;
  if (pct < 0.1) return null;

  const rowByMonth = new Map(monthly.map((r) => [r.month, r]));
  const currentMonthKey = todayIso.slice(0, 7);
  const [ty, tm, td] = todayIso.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  const monthPct = td / daysInMonth;

  // liveSoFar(metric): current-month accrual = window totals minus prior
  // in-period completed months (clamped ≥0).
  const priorSum = (k: ForecastMetric) => {
    let s = 0;
    for (const r of monthly) if (r.month < currentMonthKey) s += r[k];
    return s;
  };
  const liveSoFar = (k: ForecastMetric) =>
    Math.max(0, (totals as Record<ForecastMetric, number>)[k] - priorSum(k));

  // historicalBaseline: median of up to the last 3 completed months.
  const completed = monthly
    .filter((r) => r.month < currentMonthKey)
    .sort((a, b) => (a.month < b.month ? 1 : -1))
    .slice(0, 3);
  const historicalBaseline = (k: ForecastMetric) =>
    median(completed.map((r) => r[k]));

  const curRow = rowByMonth.get(currentMonthKey);
  const monthBudget = curRow?.budget ?? 0;
  const liveSpend = liveSoFar("spend");
  const spendGate = liveSpend >= Math.max(200, monthBudget * 0.15);
  const countsGate = liveSoFar("leads") >= 3;
  const isCurrentPartial =
    !!curRow && monthPct >= 0.1 && monthPct <= 1;

  const segmentProjection = (k: ForecastMetric): number | null => {
    if (!isCurrentPartial) return null;
    // Single-month shortcut: the live period IS this calendar month.
    if (window.startIso.slice(0, 7) === currentMonthKey && window.endIso.slice(0, 7) === currentMonthKey) {
      if (k === "spend") return budgetTotal;
      return liveSpend > 0 ? budgetTotal * (liveSoFar(k) / liveSpend) : null;
    }
    const gatePasses = k === "spend" ? spendGate : countsGate;
    if (!gatePasses) return k === "spend" && monthBudget > 0 ? monthBudget : null;
    const live = liveSoFar(k);
    const baseline = historicalBaseline(k);
    if (baseline === null) {
      // No history → linear (spend) / efficiency (counts).
      if (k === "spend") return live / monthPct;
      return liveSpend > 0 ? (liveSpend / monthPct) * (live / liveSpend) : null;
    }
    const linear = live / monthPct;
    const w = monthPct;
    const blended = (1 - w) * baseline + w * linear;
    if (k === "spend") return blended;
    return Math.min(blended, Math.max(2 * live, 3 * baseline));
  };

  // Enumerate every calendar month from start to end inclusive.
  const monthKeys: string[] = [];
  let cy = new Date(start).getUTCFullYear();
  let cm = new Date(start).getUTCMonth() + 1;
  const endKey = `${new Date(end).getUTCFullYear()}-${String(new Date(end).getUTCMonth() + 1).padStart(2, "0")}`;
  for (let i = 0; i < 60; i++) {
    const mk = `${cy}-${String(cm).padStart(2, "0")}`;
    monthKeys.push(mk);
    if (mk >= endKey) break;
    cm++;
    if (cm > 12) {
      cm = 1;
      cy++;
    }
  }

  const agg = { spend: 0, leads: 0, scheduled: 0, meetings: 0 };
  for (const mk of monthKeys) {
    const row = rowByMonth.get(mk);
    for (const k of FORECAST_METRICS) {
      if (mk < currentMonthKey) {
        agg[k] += row ? row[k] : 0;
      } else if (mk === currentMonthKey) {
        const proj = segmentProjection(k);
        agg[k] += proj !== null ? proj : row ? row[k] : 0;
      } else {
        const baseline = historicalBaseline(k);
        if (baseline !== null) agg[k] += baseline;
        else if (k === "spend" && row && row.budget > 0) agg[k] += row.budget;
      }
    }
  }
  return {
    spend: agg.spend,
    leads: agg.leads,
    scheduled: agg.scheduled,
    meetings: agg.meetings,
    budget: budgetTotal,
    daysLeft: Math.max(0, Math.round((end - today) / 86400000)),
  };
}

export type PrevFunnel = {
  spend: number;
  leads: number;
  scheduled: number;
  meetings: number;
  costPerLead: number;
  ratioApplied: number;
};

/** Legacy computePrevFunnel (Index.html:4413) — previous calendar month
 *  from monthlyRaw, day-ratio-scaled to the elapsed portion of the
 *  current period. null when no prior-month rows. */
export function computePrevFunnel(
  window: ReportWindow,
  monthly: MonthlyRow[],
  todayIso: string,
): PrevFunnel | null {
  if (!window.startIso || !monthly.length) return null;
  const [y, m] = window.startIso.split("-").map(Number);
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  const prevMonth = `${prevY}-${String(prevM).padStart(2, "0")}`;
  const rows = monthly.filter((r) => r.month === prevMonth);
  if (!rows.length) return null;
  const sum = (k: keyof MonthlyRow) =>
    rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const rawSpend = sum("spend");
  const rawLeads = sum("leads");
  const rawSched = sum("scheduled");
  const rawMeet = sum("meetings");
  const startMs = Date.parse(window.startIso);
  const endMs = window.endIso ? Date.parse(window.endIso) : Date.parse(todayIso);
  const todayMs = Date.parse(todayIso);
  const effEnd = todayMs < endMs ? todayMs : endMs;
  const daysElapsed = Math.max(1, Math.round((effEnd - startMs) / 86400000) + 1);
  const daysInPrev = new Date(Date.UTC(prevY, prevM, 0)).getUTCDate();
  const ratio = Math.min(1, daysElapsed / daysInPrev);
  const leads = Math.round(rawLeads * ratio);
  const scheduled = Math.round(rawSched * ratio);
  const meetings = Math.round(rawMeet * ratio);
  const spend = rawSpend * ratio;
  return {
    spend,
    leads,
    scheduled,
    meetings,
    costPerLead: leads > 0 ? spend / leads : 0,
    ratioApplied: ratio,
  };
}

export type ReportAnomaly = { type: "good" | "bad"; text: string };

/** Legacy detectAnomalies (Index.html:4465) — period-over-period media
 *  + CRM anomaly chips (pickChannelAlerts covers the per-channel ones). */
export function detectAnomalies(
  totals: { spend: number; leads: number; scheduled: number; meetings: number },
  prevFunnel: PrevFunnel | null,
  sm: SmTotals,
  prevSm: SmTotals | null,
): ReportAnomaly[] {
  const out: ReportAnomaly[] = [];
  const pctD = (cur: number, prev: number) => {
    if (prev === 0) return cur > 0 ? "+∞" : "0%";
    const p = ((cur - prev) / prev) * 100;
    return (p >= 0 ? "+" : "") + p.toFixed(0) + "%";
  };
  const drop = (cur: number, prev: number, t: number) => prev > 0 && cur < prev * (1 - t);
  const rise = (cur: number, prev: number, t: number) => prev > 0 && cur > prev * (1 + t);

  if (sm && prevSm) {
    if (drop(sm.ctr, prevSm.ctr, 0.3) && sm.impressions > 1000)
      out.push({ type: "bad", text: `📉 CTR ירד משמעותית (${pctD(sm.ctr, prevSm.ctr)}) — מ-${fmtPct2(prevSm.ctr)} ל-${fmtPct2(sm.ctr)}` });
    if (rise(sm.cpc, prevSm.cpc, 0.35))
      out.push({ type: "bad", text: `💸 CPC עלה בחדות (${pctD(sm.cpc, prevSm.cpc)}) — מ-${fmtILS(prevSm.cpc)} ל-${fmtILS(sm.cpc)}` });
    if (prevSm.conversions > 0 && sm.conversions === 0)
      out.push({ type: "bad", text: `⛔ המרות Google צנחו ל-0 (מ-${fmtInt(prevSm.conversions)} בתקופה הקודמת)` });
    if (prevSm.fbLeads > 0 && sm.fbLeads === 0)
      out.push({ type: "bad", text: `⛔ לידים בפייסבוק צנחו ל-0 (מ-${fmtInt(prevSm.fbLeads)} בתקופה הקודמת)` });
    if (rise(sm.impressions, prevSm.impressions, 0.5))
      out.push({ type: "good", text: `🚀 זינוק בחשיפות (${pctD(sm.impressions, prevSm.impressions)}) — מ-${fmtInt(prevSm.impressions)} ל-${fmtInt(sm.impressions)}` });
  }

  if (prevFunnel) {
    const p = prevFunnel;
    if (rise(totals.leads, p.leads, 0.5))
      out.push({ type: "good", text: `🎯 זינוק בלידים (${pctD(totals.leads, p.leads)}) — מ-${fmtInt(p.leads)} ל-${fmtInt(totals.leads)}` });
    if (drop(totals.leads, p.leads, 0.3) && p.leads > 5)
      out.push({ type: "bad", text: `⚠️ לידים ירדו ב-${pctD(totals.leads, p.leads)} — מ-${fmtInt(p.leads)} ל-${fmtInt(totals.leads)}` });
    if (rise(totals.meetings, p.meetings, 0.4))
      out.push({ type: "good", text: `🏆 זינוק בביצועי פגישה (${pctD(totals.meetings, p.meetings)}) — מ-${fmtInt(p.meetings)} ל-${fmtInt(totals.meetings)}` });
    if (rise(totals.spend, p.spend, 0.3) && drop(totals.leads, p.leads, 0.2))
      out.push({ type: "bad", text: `🔻 הוצאה עלתה (${pctD(totals.spend, p.spend)}) אך לידים ירדו (${pctD(totals.leads, p.leads)}) — ירידה ביעילות` });
    const curCpl = totals.leads > 0 ? totals.spend / totals.leads : 0;
    if (rise(curCpl, p.costPerLead, 0.5) && totals.leads > 3)
      out.push({ type: "bad", text: `📈 עלות לליד עלתה ב-${pctD(curCpl, p.costPerLead)} — מ-${fmtILS(p.costPerLead)} ל-${fmtILS(curCpl)}` });
  }
  return out;
}

/* ---------------------------- creatives types ---------------------------- */

export type ReportAdDaily = { date: string; cost: number; leads: number };

export type ReportFbAd = {
  account: string;
  campaign: string;
  ad: string;
  status: string;
  /** "Link to promoted post" — only from the assets lookup. */
  url: string;
  destUrl: string;
  body: string;
  title: string;
  thumb: string;
  image: string;
  impressions: number;
  clicks: number;
  cost: number;
  leads: number;
  cpl: number;
  ctr: number;
  /** Warehouse CRM joins (0/absent hides the CRM row). */
  crmLeads: number;
  scheduled: number;
  held: number;
  costPerSched: number;
  costPerHeld: number;
  ageDays: number;
  ctrEarly: number;
  ctrRecent: number;
  fatigued: boolean;
  fatigueReason: "" | "declining" | "long";
  isWinner: boolean;
  daily: ReportAdDaily[];
};

export type ReportFbAdSet = {
  name: string;
  cost: number;
  leads: number;
  cpl: number;
  crmLeads: number;
  scheduled: number;
  held: number;
  costPerSched: number;
  costPerHeld: number;
  daily: ReportAdDaily[];
};

export type ReportGoogleAd = {
  account: string;
  campaign: string;
  status: string;
  impressions: number;
  finalUrl: string;
  headlines: string[];
  descriptions: string[];
};

export type ReportKeyword = {
  keyword: string;
  impressions: number;
  clicks: number;
  conversions: number;
  scheduled: number;
  held: number;
};

export type ReportCreatives = {
  fb: {
    cost: number;
    leads: number;
    cpl: number;
    /** ACTIVE ads in the (unsliced) topAds list. */
    adCount: number;
    topAds: ReportFbAd[];
    topAdSets: ReportFbAdSet[];
  };
  google: {
    clicks: number;
    conversions: number;
    topKeywords: ReportKeyword[];
    ads: ReportGoogleAd[];
  };
};

/** Legacy `fbStatusInfo` (Index.html:3597) — FB ad status → pill. */
export function fbStatusInfo(raw: string): { label: string; cls: string } {
  const s = String(raw || "").toUpperCase().trim();
  if (!s) return { label: "", cls: "" };
  if (s === "ACTIVE") return { label: "🟢 פעילה", cls: "active" };
  if (s === "PAUSED") return { label: "⏸ מושהית", cls: "paused" };
  if (s === "ADSET_PAUSED") return { label: "⏸ קהל מושהה", cls: "paused" };
  if (s === "CAMPAIGN_PAUSED") return { label: "⏸ קמפיין מושהה", cls: "paused" };
  if (s === "DELETED") return { label: "🗑 נמחקה", cls: "deleted" };
  if (s === "ARCHIVED") return { label: "🗑 בארכיון", cls: "deleted" };
  if (
    s === "DISAPPROVED" ||
    s === "PENDING_REVIEW" ||
    s === "PENDING_BILLING_INFO" ||
    s === "WITH_ISSUES"
  )
    return { label: "⚠️ בעיה", cls: "issue" };
  return { label: raw, cls: "other" };
}

/* --------------------------- channels tab math --------------------------- */

export type ChannelPacing = {
  cls: "pacing-on" | "pacing-mild" | "pacing-warn" | "pacing-severe" | "";
  action: "" | "lower" | "raise" | "investigate";
  /** Tooltip lines (plain text). */
  lines: string[];
};

/**
 * Legacy `pacingCellAttrs` (Index.html:6365), simplified: the 12%
 * configured-vs-planned rule drives ⬇/⬆, the ±10% actual-vs-plan variance
 * drives 🔍/the no-config fallback, and a negative planned (sheet formula
 * went negative = budget exhausted) is severe. Omitted vs legacy: the
 * per-campaign escalation detail (needs per-campaign daily actuals the
 * hub doesn't aggregate yet).
 */
export function computeChannelPacing(c: {
  dailyRate: number;
  configuredDaily: number | null;
  avg7d: number | null;
}): ChannelPacing {
  const planned = c.dailyRate;
  if (!planned) return { cls: "", action: "", lines: [] };
  if (planned < 0) {
    const lines = [
      `⚠️ תקציב התקופה נוצל — הקצב היומי הנדרש שלילי (${fmtILS(planned)})`,
    ];
    if (c.configuredDaily != null)
      lines.push(`מוגדר בפלטפורמה: ${fmtILS(c.configuredDaily)}`);
    lines.push("💡 מומלץ לעצור או לצמצם משמעותית — המשך הוצאה = חריגה נוספת");
    return { cls: "pacing-severe", action: "lower", lines };
  }
  const PACE_TOL = 0.12;
  const lines: string[] = [`מתוכנן: ${fmtILS(planned)}`];
  let action: ChannelPacing["action"] = "";
  let gap = 0;
  const hasConfig = c.configuredDaily != null && c.configuredDaily > 0;
  if (hasConfig) {
    const configured = c.configuredDaily!;
    lines.push(`מוגדר בפלטפורמה: ${fmtILS(configured)}`);
    const configVsPlan = (configured - planned) / planned;
    gap = Math.abs(configVsPlan);
    if (configVsPlan > PACE_TOL) {
      action = "lower";
      lines.push(
        `💡 מומלץ להוריד את התקציב בפלטפורמה ל־${fmtILS(planned)} (כרגע מוגדר ${fmtILS(configured)}, פער ${Math.round(gap * 100)}% מהתכנון)`,
      );
    } else if (configVsPlan < -PACE_TOL) {
      action = "raise";
      lines.push(
        `💡 מומלץ להעלות את התקציב בפלטפורמה ל־${fmtILS(planned)} (כרגע מוגדר ${fmtILS(configured)})`,
      );
    } else if (c.avg7d != null) {
      const variance = (c.avg7d - planned) / planned;
      lines.push(`ממוצע 7 ימים: ${fmtILS(c.avg7d)}`);
      if (variance > 0.1) {
        action = "investigate";
        gap = Math.abs(variance);
        lines.push(
          `🔍 התקציב מוגדר כהלכה (${fmtILS(configured)}) אבל הפלטפורמה מוציאה ${fmtILS(c.avg7d)}/יום (פער ${Math.round(variance * 100)}%) — בדקו שינויי CPC / CBO / עונתיות, לא תקציב`,
        );
      } else if (variance < -0.1) {
        action = "investigate";
        gap = Math.abs(variance);
        lines.push(
          `🔍 התקציב מוגדר כהלכה (${fmtILS(configured)}) אבל הפלטפורמה מוציאה רק ${fmtILS(c.avg7d)}/יום — בדקו קהלים / הצעות מחיר / קריאייטיבים, לא תקציב`,
        );
      }
    }
  } else if (c.avg7d != null) {
    // No configured budget known (Taboola/Outbrain/unmatched) —
    // spend-variance fallback.
    const variance = (c.avg7d - planned) / planned;
    gap = Math.abs(variance);
    lines.push(`ממוצע 7 ימים: ${fmtILS(c.avg7d)}`);
    if (variance > 0.1) {
      action = "lower";
      lines.push(`💡 מומלץ להוריד את התקציב היומי ל־${fmtILS(planned)}`);
    } else if (variance < -0.1) {
      action = "raise";
      lines.push(`💡 מומלץ להעלות את התקציב היומי ל־${fmtILS(planned)}`);
    }
  }
  const cls =
    action === "lower" || action === "raise"
      ? gap >= 0.5
        ? "pacing-severe"
        : "pacing-warn"
      : action === "investigate"
        ? "pacing-mild"
        : "pacing-on";
  return { cls, action, lines };
}

/** Legacy `costStyle` (Index.html:6164) — green→red heat on cost-per
 *  cells, same hue bands for rows and totals. undefined for v ≤ 0. */
export function costHeatStyle(
  metric: "costPerLead" | "costPerScheduled" | "costPerMeeting",
  v: number,
): { background: string; color: string; fontWeight: number } | undefined {
  if (!v || v <= 0) return undefined;
  const [lo, hi] =
    metric === "costPerLead"
      ? [150, 700]
      : metric === "costPerScheduled"
        ? [1500, 4500]
        : [4000, 12000];
  let t = (v - lo) / (hi - lo);
  t = Math.max(0, Math.min(1, t));
  const hue = Math.round(140 - t * 140);
  return {
    background: `hsl(${hue},70%,88%)`,
    color: `hsl(${hue},70%,26%)`,
    fontWeight: 600,
  };
}

/** Legacy `convCls` (Index.html:6183) — conversion-rate cell tone. */
export function convTone(r: number | null): "none" | "green" | "amber" | "red" {
  if (r === null) return "none";
  if (r >= 0.6) return "green";
  if (r >= 0.3) return "amber";
  return "red";
}

export type ChannelAlert = { type: "good" | "bad"; text: string };

/** Legacy `pickAlerts(p.channels)` (Index.html:4520) — the two
 *  per-channel strip chips. `icon` renders the channel display name. */
export function pickChannelAlerts(
  channels: ReportChannel[],
  icon: (name: string) => string,
): ChannelAlert[] {
  const out: ChannelAlert[] = [];
  const active = channels.filter((c) => c.spend > 0);
  const withLeads = active
    .filter((c) => c.leads > 0 && c.costPerLead > 0)
    .sort((a, b) => a.costPerLead - b.costPerLead);
  if (withLeads.length) {
    const best = withLeads[0];
    out.push({
      type: "good",
      text: `⭐ הערוץ המוביל: ${icon(best.channel)} — ${fmtILS(best.costPerLead)} לליד`,
    });
  }
  const noLeads = active.filter((c) => c.leads === 0 && c.spend > 500);
  if (noLeads.length) {
    out.push({
      type: "bad",
      text: `⚠️ תקציב ללא לידים: ${noLeads.map((c) => icon(c.channel)).join(", ")}`,
    });
  }
  return out;
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
