"use client";

import { useMemo, useState } from "react";
import { channelIcon } from "@/lib/channelIcon";
import { pacingChannelKey } from "@/lib/budgetTypes";
import ReportChannelCharts from "@/components/report/ReportChannelCharts";
import CopyAmountButton from "@/components/CopyAmountButton";
import GoogleAdsIcon from "@/components/GoogleAdsIcon";
import FacebookAdsIcon from "@/components/FacebookAdsIcon";

/** Ads-manager deep links (Keys accounts → platform URL) for the pacing
 *  copy-and-open control + the internal quick-links row. Built by the Apps
 *  Script (getProjectAdLinks). `sheetUrl` = the "דוח ביצועים" Google Sheet. */
export type ReportAdLinks = {
  gAdsUrl: string;
  fbAdsUrl: string;
  sheetUrl?: string;
};
import {
  computeChannelPacing,
  costHeatStyle,
  convTone,
  pickChannelAlerts,
  diagnosePaidChannels,
  fmtInt,
  fmtILS,
  fmtDateHe,
  type ProjectReportData,
  type ReportChannel,
} from "@/lib/reportShared";

/**
 * ערוצים tab — the native rebuild of the legacy 📋 פירוט ערוצים table
 * (Index.html:5770): 12 sortable columns (תקציב + קצב יומי hidden in
 * month mode), cost-per heat coloring, conversion-rate tones, totals
 * row, the pacing cell with the 12% configured-vs-required rule
 * (⬇/⬆/🔍 + ✓טיפלתי snooze sharing the iframe/budget-desk dismissal
 * keys), campaign live/paused dots, flight chips + mini-gantt, and the
 * pickAlerts strip. Not yet ported: pixel-divergence ⚠️, CPL-trend ▲▼,
 * end-date-mismatch ⚠️, per-campaign tooltip detail, free-range mode.
 */

export type PacingDismissal = {
  snooze_until: string;
  dismissed_at: string;
  reason: string;
};

/** "emoji name" channel label (legacy channelIcon returned both; the
 *  hub port returns just the emoji). */
const chLabel = (name: string) =>
  `${channelIcon(name) || "●"} ${name}`.trim();

type DayPt = { date: string; cost: number; leads: number };

/** A google channel LABEL that denotes the discovery/PMax/demand-gen
 *  family (vs search). Mirrors reportData's googleCampaignKind so the
 *  channel-row → daily-series mapping agrees with how the campaigns were
 *  bucketed. A plain "google" label matches NEITHER this nor a search
 *  token — it's treated as the non-discovery (search) side when a
 *  discovery row exists, else as all-google (see hasGoogleDiscovery). */
const GOOGLE_DISCOVERY_LABEL_RE = /discover|p-?max|demand|dgen|display/i;

/** Zero-filled daily series clamped to the last date that actually has
 *  data, so the sparkline doesn't trail into future zeros — mirrors the
 *  legacy `_buildAdTrendlinePopover_` windowing (Index.html:6890). */
function windowDaily(
  series: { date: string; cost: number; leads: number }[],
  startIso: string,
  endIso: string,
): DayPt[] {
  if (!series.length || !startIso || !endIso) return [];
  const byDate = new Map(series.map((p) => [p.date, p]));
  const inWin = series.filter((p) => p.date >= startIso && p.date <= endIso);
  if (!inWin.length) return [];
  let lastData = "";
  for (const p of inWin)
    if ((p.cost > 0 || p.leads > 0) && p.date > lastData) lastData = p.date;
  const end = lastData && lastData >= startIso ? lastData : endIso;
  const out: DayPt[] = [];
  const cur = new Date(`${startIso}T00:00:00Z`);
  const endD = new Date(`${end}T00:00:00Z`);
  let guard = 0;
  while (cur <= endD && guard++ < 400) {
    const iso = cur.toISOString().slice(0, 10);
    const p = byDate.get(iso);
    out.push({ date: iso, cost: p?.cost ?? 0, leads: p?.leads ?? 0 });
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

const ddmm = (iso: string) => {
  const [, m, d] = iso.split("-");
  return d && m ? `${d}/${m}` : iso;
};

/** Hover popover: two independently auto-scaled SVG line-sparklines
 *  (daily cost teal + leads purple) across the report window. Port of
 *  the legacy `_buildAdTrendlinePopover_` (Index.html:6885) — shown on
 *  google/facebook rows only (the platform daily feed covers those). */
function ChannelTrendPop({
  channel,
  series,
}: {
  channel: string;
  series: DayPt[];
}) {
  const W = 240;
  const H = 42;
  const PAD = 2;
  const innerW = W - PAD * 2;
  const innerH = H - PAD * 2;
  const maxCost = series.reduce((m, r) => Math.max(m, r.cost), 0);
  const maxLeads = series.reduce((m, r) => Math.max(m, r.leads), 0);
  const xAt = (i: number) =>
    series.length <= 1
      ? PAD + innerW / 2
      : PAD + (i / (series.length - 1)) * innerW;
  const yOf = (v: number, max: number) =>
    max <= 0 ? PAD + innerH : PAD + innerH - (v / max) * innerH;
  const path = (key: "cost" | "leads", max: number) =>
    series
      .map(
        (r, i) =>
          (i === 0 ? "M" : "L") +
          xAt(i).toFixed(1) +
          " " +
          yOf(r[key], max).toFixed(1),
      )
      .join(" ");
  const totalCost = series.reduce((s, r) => s + r.cost, 0);
  const totalLeads = series.reduce((s, r) => s + r.leads, 0);
  return (
    <div className="rpt-chtrend-pop" aria-hidden="true">
      <div className="rpt-chtrend-head">
        {channel} · {ddmm(series[0].date)} →{" "}
        {ddmm(series[series.length - 1].date)}
      </div>
      <div className="rpt-chtrend-row">
        <span className="rpt-chtrend-label">💸 עלות</span>
        <svg viewBox={`0 0 ${W} ${H}`} className="rpt-chtrend-svg">
          <path
            d={path("cost", maxCost)}
            fill="none"
            stroke="#14b8a6"
            strokeWidth={1.6}
          />
        </svg>
        <span className="rpt-chtrend-total">{fmtILS(totalCost)}</span>
      </div>
      <div className="rpt-chtrend-row">
        <span className="rpt-chtrend-label">🎯 לידים</span>
        <svg viewBox={`0 0 ${W} ${H}`} className="rpt-chtrend-svg">
          <path
            d={path("leads", maxLeads)}
            fill="none"
            stroke="#8b5cf6"
            strokeWidth={1.6}
          />
        </svg>
        <span className="rpt-chtrend-total">{fmtInt(totalLeads)}</span>
      </div>
    </div>
  );
}

type FadeState = "active" | "dismissed" | "resurfaced";

function ilToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(
    new Date(),
  );
}

function ilDayOf(ts: string): string {
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(
    new Date(ms),
  );
}

/** Port of the shared computeFadeState semantics (BudgetGrid /
 *  legacy `_pacingFadeState`): same-IL-day stays dismissed; overnight
 *  passed AND the gap still fires → resurfaced; expired/restored →
 *  active. `local` is this session's optimistic override. */
function fadeStateOf(
  d: PacingDismissal | undefined,
  today: string,
  local: "on" | "off" | undefined,
  gapStillOff: boolean,
): FadeState {
  if (local === "off") return "active";
  if (local === "on") return "dismissed";
  if (!d) return "active";
  if (!d.snooze_until || d.snooze_until < today) return "active";
  const day = d.dismissed_at ? ilDayOf(d.dismissed_at) : "";
  if (day && day < today && gapStillOff) return "resurfaced";
  return "dismissed";
}

type SortKey =
  | "channel"
  | "budget"
  | "spend"
  | "leads"
  | "cpl"
  | "r1"
  | "scheduled"
  | "cps"
  | "r2"
  | "meetings"
  | "cpm"
  | "daily";

const r1Of = (c: ReportChannel) => (c.leads > 0 ? c.scheduled / c.leads : null);
const r2Of = (c: ReportChannel) =>
  c.scheduled > 0 ? c.meetings / c.scheduled : null;

const SORT_VAL: Record<SortKey, (c: ReportChannel) => number | string> = {
  channel: (c) => c.channel.toLowerCase(),
  budget: (c) => c.budget,
  spend: (c) => c.spend,
  leads: (c) => c.leads,
  cpl: (c) => (c.costPerLead > 0 ? c.costPerLead : -1),
  r1: (c) => r1Of(c) ?? -1,
  scheduled: (c) => c.scheduled,
  cps: (c) => (c.costPerScheduled > 0 ? c.costPerScheduled : -1),
  r2: (c) => r2Of(c) ?? -1,
  meetings: (c) => c.meetings,
  cpm: (c) => (c.costPerMeeting > 0 ? c.costPerMeeting : -1),
  daily: (c) => c.dailyRate,
};

const STATUS_DOT: Record<
  ReportChannel["campaignStatus"],
  { cls: string; title: string } | null
> = {
  none: null,
  active: { cls: "is-ok", title: "קמפיין פעיל" },
  paused: { cls: "is-off", title: "קמפיין מושהה" },
  mixed: { cls: "is-mixed", title: "חלק מהקמפיינים מושהים" },
};

function ConvCell({ r }: { r: number | null }) {
  const tone = convTone(r);
  return (
    <td className={`rpt-conv rpt-conv-${tone}`}>
      {r !== null ? `← ${(Math.round(r * 10000) / 100).toString()}%` : "—"}
    </td>
  );
}

/** תקציב חודשי strip — the 4 budget-desk summary cells (יעד E3 / חולק /
 *  פער / ימים), collapsible. Ports renderBudgetStripBody's summary row
 *  (Index.html:9386); the suggestion engine lives on the budget desk. */
function BudgetStrip({
  s,
}: {
  s: NonNullable<ProjectReportData["budgetSummary"]>;
}) {
  const [open, setOpen] = useState(false);
  const driftAbs = Math.abs(s.delta);
  const tone = !s.e3 ? "unknown" : driftAbs < 100 ? "ok" : "drift";
  const stateLabel =
    tone === "ok" ? "מסונכרן" : tone === "unknown" ? "אין יעד" : `פער ${fmtILS(driftAbs)}`;
  return (
    <div className="rpt-bstrip">
      <button
        type="button"
        className="rpt-bstrip-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span>💰</span>
        <span className="rpt-bstrip-title">תקציב חודשי</span>
        <span className={`rpt-bstrip-state is-${tone}`}>{stateLabel}</span>
        <span className="rpt-bstrip-caret">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="rpt-bstrip-body">
          <div className="rpt-bstrip-cell">
            <div className="rpt-bstrip-lbl">יעד (E3)</div>
            <div className="rpt-bstrip-val">{s.e3 > 0 ? fmtILS(s.e3) : "—"}</div>
          </div>
          <div className="rpt-bstrip-cell">
            <div className="rpt-bstrip-lbl">חולק</div>
            <div className="rpt-bstrip-val">{fmtILS(s.allocated)}</div>
          </div>
          <div className={`rpt-bstrip-cell rpt-bstrip-delta is-${tone}`}>
            <div className="rpt-bstrip-lbl">פער</div>
            <div className="rpt-bstrip-val">
              {s.delta > 0 ? "+" : s.delta < 0 ? "−" : ""}
              {fmtILS(driftAbs)}
            </div>
          </div>
          <div className="rpt-bstrip-cell">
            <div className="rpt-bstrip-lbl">ימים שנותרו</div>
            <div className="rpt-bstrip-val">
              {s.remainingDays} / {s.totalDays}
            </div>
          </div>
          <a className="rpt-bstrip-link" href="/morning/budgets">
            שולחן התקציבים ↗
          </a>
        </div>
      )}
    </div>
  );
}

/** Inline-editable תקציב cell (media/felix) — writes col G on the
 *  project tab via /api/campaigns/budget lookup mode (distribute across
 *  merged sub-campaign rows when needed), with the same drift guard the
 *  budget desk uses. */
function BudgetCell({
  tabSlug,
  channel,
  budget,
  distribute,
}: {
  tabSlug: string;
  channel: string;
  budget: number;
  distribute: boolean;
}) {
  const [value, setValue] = useState(budget);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(Math.round(budget)));
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [err, setErr] = useState("");

  const save = async () => {
    setEditing(false);
    const next = Math.round(Number(draft.replace(/[^\d.-]/g, "")));
    if (!Number.isFinite(next) || next === Math.round(value)) {
      setDraft(String(Math.round(value)));
      return;
    }
    setState("saving");
    setErr("");
    try {
      const res = await fetch("/api/campaigns/budget", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: tabSlug,
          channel,
          value: next,
          expectedBudget: Math.round(value),
          distribute,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setValue(next);
      setDraft(String(next));
      setState("saved");
      setTimeout(() => setState("idle"), 1500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setDraft(String(Math.round(value)));
      setState("error");
    }
  };

  if (editing) {
    return (
      <input
        className="rpt-budcell-input"
        type="text"
        inputMode="numeric"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") {
            setDraft(String(Math.round(value)));
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <button
      type="button"
      className={"rpt-budcell-btn is-" + state}
      title={
        state === "error"
          ? `שגיאה: ${err}`
          : distribute
            ? "לחצו לעריכה — יחולק יחסית בין תתי-הקמפיינים · נשמר ל-Google Sheet"
            : "לחצו לעריכה — נשמר ל-Google Sheet"
      }
      onClick={() => {
        setDraft(String(Math.round(value)));
        setEditing(true);
      }}
    >
      {fmtILS(value)}
      {state === "saving" && " …"}
      {state === "saved" && " ✓"}
      {state === "error" && " ⚠️"}
    </button>
  );
}

function ChannelGantt({
  channels,
  window,
  currentKey,
}: {
  channels: ReportChannel[];
  window: { startIso: string; endIso: string };
  currentKey: string;
}) {
  const ps = Date.parse(window.startIso);
  const pe = Date.parse(window.endIso);
  const span = Math.max(1, pe - ps);
  const pct = (t: number) => Math.max(0, Math.min(100, ((t - ps) / span) * 100));
  const todayMs = Date.parse(ilToday());
  const todayPct = todayMs >= ps && todayMs <= pe ? pct(todayMs) : null;
  const rows = channels.filter((c) => c.startIso && c.endIso);
  if (!rows.length) return null;
  return (
    <div className="rpt-gantt">
      <div className="rpt-gantt-head">
        טווח הפרויקט · {fmtDateHe(window.startIso)} – {fmtDateHe(window.endIso)}
      </div>
      {rows.map((c) => {
        const left = pct(Date.parse(c.startIso));
        const width = Math.max(1.5, pct(Date.parse(c.endIso)) - left);
        const util =
          c.budget > 0
            ? Math.min(100, (c.spend / c.budget) * 100)
            : c.spend > 0
              ? 100
              : 0;
        const over = c.budget > 0 && c.spend > c.budget;
        const cur = c.channel.toLowerCase() === currentKey;
        return (
          <div key={c.channel} className={"rpt-gantt-row" + (cur ? " is-cur" : "")}>
            <span className="rpt-gantt-label" title={c.channel}>
              {chLabel(c.channel)}
            </span>
            <span className="rpt-gantt-track">
              {todayPct !== null && (
                <span
                  className="rpt-gantt-today"
                  style={{ insetInlineStart: `${todayPct}%` }}
                  title="היום"
                />
              )}
              <span
                className={"rpt-gantt-bar" + (over ? " is-over" : "")}
                style={{ insetInlineStart: `${left}%`, width: `${width}%` }}
              >
                <span className="rpt-gantt-fill" style={{ width: `${util}%` }} />
              </span>
            </span>
            <span className="rpt-gantt-meta">
              {fmtDateHe(c.startIso).slice(0, 5)}–{fmtDateHe(c.endIso).slice(0, 5)}{" "}
              · {fmtILS(c.spend)} / {c.budget > 0 ? fmtILS(c.budget) : "—"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function ReportChannelsTab({
  data,
  pacingDismissals,
  canEditBudget = false,
  adLinks = null,
}: {
  data: ProjectReportData;
  pacingDismissals: Record<string, PacingDismissal>;
  canEditBudget?: boolean;
  adLinks?: ReportAdLinks | null;
}) {
  const isMonth = data.mode === "month";
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  const [localDismiss, setLocalDismiss] = useState<Record<string, "on" | "off">>(
    {},
  );
  const [ganttFor, setGanttFor] = useState<string | null>(null);
  // Channel filter (multi-select). null = all channels shown. Mirrors the
  // legacy `applyChannelsTableFilter` — hides rows + recomputes totals only;
  // the four charts stay on the full channel set.
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const today = useMemo(ilToday, []);

  const channels = data.channels;
  // Does this project break google into a discovery row? If so, a
  // non-discovery google row is the search-only side of the split; if
  // not, a lone "google" row still represents all-google. Computed from
  // the full channel set so channel-filtering can't flip it.
  const hasGoogleDiscovery = channels.some(
    (c) => c.platform === "google" && GOOGLE_DISCOVERY_LABEL_RE.test(c.channel),
  );
  const sorted = useMemo(() => {
    if (!sort) return channels;
    const val = SORT_VAL[sort.key];
    return [...channels].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (typeof av === "string" || typeof bv === "string")
        return String(av).localeCompare(String(bv)) * sort.dir;
      return ((av as number) - (bv as number)) * sort.dir;
    });
  }, [channels, sort]);
  const visible = useMemo(
    () =>
      selected === null ? sorted : sorted.filter((c) => selected.has(c.channel)),
    [sorted, selected],
  );

  if (data.mode === "range") {
    return (
      <div className="rpt-empty">
        פירוט ערוצים בטווח מותאם עדיין לא זמין בדוח החדש — השתמשו בתצוגה
        הקלאסית לטווחים חופשיים.
      </div>
    );
  }
  if (!channels.length) {
    return <div className="rpt-empty">אין שורות ערוצים לפרויקט בתקופה הזו.</div>;
  }

  const alerts = pickChannelAlerts(channels, chLabel);
  const datesIrregular =
    !isMonth &&
    !!data.window.startIso &&
    !!data.window.endIso &&
    channels.some(
      (c) =>
        c.startIso &&
        c.endIso &&
        (c.startIso !== data.window.startIso || c.endIso !== data.window.endIso),
    );

  // Totals reflect the *visible* (filtered) rows — matches the legacy
  // recomputeChannelsTableTotals so the bottom line agrees with the rows.
  const totals = visible.reduce(
    (t, c) => {
      t.budget += c.budget;
      t.spend += c.spend;
      t.leads += c.leads;
      t.scheduled += c.scheduled;
      t.meetings += c.meetings;
      t.daily += c.dailyRate;
      return t;
    },
    { budget: 0, spend: 0, leads: 0, scheduled: 0, meetings: 0, daily: 0 },
  );

  // One budget-utilization bar per row, spanning the תקציב + עלות cells: the
  // TRACK length ∝ this channel's budget (biggest budget in view = full width,
  // small budget = short bar), and it's FILLED to the actual spend on the same
  // scale (red when over budget). The bar is split across the two equal-width
  // cells — `a`/`b` are this cell's slice of the combined [0,1] bar: in RTL the
  // right cell (תקציב) is [0,.5], the left cell (עלות) is [.5,1]. Only in the
  // non-month view where both cells exist.
  const maxBudget = Math.max(1, ...visible.map((c) => c.budget));
  // Fill COLOUR = the channel's pacing health (green on-pace → red badly off),
  // so the bar reads good/bad at a glance. The fill LENGTH is still the spend,
  // the track LENGTH is still the budget. Neutral slate when there's no pacing
  // verdict yet (e.g. no configured daily budget to compare against).
  const paceFill = (cls: string): string => {
    switch (cls) {
      case "pacing-on":
        return "rgba(34,197,94,0.5)"; // green — on pace
      case "pacing-mild":
        return "rgba(234,179,8,0.5)"; // amber — slight drift
      case "pacing-warn":
        return "rgba(249,115,22,0.55)"; // orange — off pace
      case "pacing-severe":
        return "rgba(239,68,68,0.5)"; // red — badly off / budget exhausted
      default:
        return "rgba(100,116,139,0.36)"; // slate — no pacing verdict
    }
  };
  const spanBar = (
    budget: number,
    spend: number,
    a: number,
    b: number,
    paceCls: string,
  ): { backgroundImage: string } | undefined => {
    const budgetR = Math.min(budget / maxBudget, 1);
    if (budgetR <= 0) return undefined;
    const spendR = Math.min(spend / maxBudget, budgetR); // fill clamped into track
    const loc = (r: number) => Math.max(0, Math.min((r - a) / (b - a), 1)) * 100;
    const bL = loc(budgetR);
    const sL = loc(spendR);
    if (bL <= 0) return undefined;
    const track = "rgba(148,163,184,0.16)"; // neutral track = budget extent
    const fill = paceFill(paceCls);
    return {
      backgroundImage: `linear-gradient(to left, ${fill} ${sL}%, ${track} ${sL}%, ${track} ${bL}%, transparent ${bL}%)`,
    };
  };

  const toggleChannel = (ch: string) =>
    setSelected((cur) => {
      const base = cur ?? new Set(channels.map((c) => c.channel));
      const next = new Set(base);
      if (next.has(ch)) next.delete(ch);
      else next.add(ch);
      // Empty or full selection both mean "all" — snap back to null.
      if (next.size === 0 || next.size === channels.length) return null;
      return next;
    });
  const allChecked = selected === null;
  const filterLabel =
    selected === null
      ? "כל הערוצים"
      : selected.size === 1
        ? chLabel([...selected][0])
        : `${selected.size} ערוצים נבחרו`;
  const tCpl = totals.leads > 0 ? totals.spend / totals.leads : 0;
  const tCps = totals.scheduled > 0 ? totals.spend / totals.scheduled : 0;
  const tCpm = totals.meetings > 0 ? totals.spend / totals.meetings : 0;
  const tR1 = totals.leads > 0 ? totals.scheduled / totals.leads : null;
  const tR2 = totals.scheduled > 0 ? totals.meetings / totals.scheduled : null;

  const onSort = (key: SortKey) =>
    setSort((cur) =>
      cur?.key === key
        ? { key, dir: cur.dir === 1 ? -1 : 1 }
        : { key, dir: key === "channel" ? 1 : -1 },
    );

  const Th = ({ k, label }: { k: SortKey; label: string }) => (
    <th
      role="button"
      tabIndex={0}
      onClick={() => onSort(k)}
      className={sort?.key === k ? "is-sorted" : undefined}
      title="מיון"
    >
      {label}
      {sort?.key === k ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
    </th>
  );

  const dismissPacing = async (c: ReportChannel, restore: boolean) => {
    const key = pacingChannelKey(data.slug, c.channel);
    setLocalDismiss((cur) => ({ ...cur, [key]: restore ? "off" : "on" }));
    try {
      const res = await fetch("/api/campaigns/budget-dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: data.slug,
          channel: c.channel,
          platform: c.platform,
          baselineDaily: c.configuredDaily ?? 0,
          restore,
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      // Roll back the optimistic state on failure.
      setLocalDismiss((cur) => ({ ...cur, [key]: restore ? "on" : "off" }));
    }
  };

  const diagCards = diagnosePaidChannels(channels);

  return (
    <div className="rpt-channels">
      {/* Internal quick-links (classic-report parity) — the performance-report
          Google Sheet + the Google/Facebook ads managers. Gated by
          canEditBudget (media/manager, not client/preview) and hidden in the
          client view (see .rpt-clientview rule). */}
      {canEditBudget &&
        adLinks &&
        (adLinks.sheetUrl || adLinks.gAdsUrl || adLinks.fbAdsUrl) && (
          <div className="rpt-ch-quicklinks">
            {adLinks.sheetUrl && (
              <a
                className="rpt-ch-qlink is-sheet"
                href={adLinks.sheetUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="פתח את גיליון דוח הביצועים (Google Sheets)"
              >
                <span aria-hidden>📊</span> דוח ביצועים
              </a>
            )}
            {adLinks.gAdsUrl && (
              <a
                className="rpt-ch-qlink is-gads"
                href={adLinks.gAdsUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="פתח את הקמפיינים ב-Google Ads"
              >
                <GoogleAdsIcon size="1em" /> Google Ads
              </a>
            )}
            {adLinks.fbAdsUrl && (
              <a
                className="rpt-ch-qlink is-fbads"
                href={adLinks.fbAdsUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="פתח את הקמפיינים ב-Facebook Ads"
              >
                <FacebookAdsIcon size="1em" /> Facebook Ads
              </a>
            )}
          </div>
        )}
      {alerts.length > 0 && (
        <div className="rpt-ch-alerts">
          {alerts.map((a, i) => (
            <div key={i} className={`rpt-ch-alert is-${a.type}`}>
              {a.text}
            </div>
          ))}
        </div>
      )}

      {data.budgetSummary && <BudgetStrip s={data.budgetSummary} />}

      {diagCards.length > 0 && (
        <div className="rpt-paid-diag">
          {diagCards.map((c, i) => (
            <div key={i} className={`rpt-pd-card is-${c.tone}`}>
              <div className="rpt-pd-head">
                {c.icon} {c.head}
              </div>
              <div dangerouslySetInnerHTML={{ __html: c.bodyHtml }} />
              {c.sample && <div className="rpt-pd-sample">{c.sample}</div>}
              {c.tipHtml && (
                <div className="rpt-pd-tip" dangerouslySetInnerHTML={{ __html: `💡 ${c.tipHtml}` }} />
              )}
            </div>
          ))}
        </div>
      )}

      {ganttFor !== null && (
        <ChannelGantt
          channels={channels}
          window={data.window}
          currentKey={ganttFor}
        />
      )}

      {channels.length > 1 && (
        <div className="rpt-ch-tablecontrols">
          <span className="rpt-ch-tablecontrols-lbl">סינון לפי ערוץ:</span>
          <div className="rpt-mt-filter">
            <button
              type="button"
              className="rpt-mt-filter-btn"
              onClick={() => setFilterOpen((o) => !o)}
              aria-expanded={filterOpen}
            >
              {filterLabel} ▾
            </button>
            {filterOpen && (
              <>
                <div
                  className="rpt-ch-filter-backdrop"
                  onClick={() => setFilterOpen(false)}
                />
                <div className="rpt-mt-filter-panel" role="listbox">
                  <label className="rpt-mt-filter-opt is-all">
                    <input
                      type="checkbox"
                      checked={allChecked}
                      ref={(el) => {
                        // Indeterminate only for a partial selection; a full
                        // deselect (empty set) reads as a clean unchecked box.
                        if (el)
                          el.indeterminate =
                            selected !== null && selected.size > 0;
                      }}
                      // Proper master toggle: when everything is shown, clicking
                      // clears the selection (empty set → no rows); otherwise it
                      // re-selects all. Previously it always set null, so clicking
                      // it while all were selected did nothing.
                      onChange={() =>
                        setSelected(allChecked ? new Set<string>() : null)
                      }
                    />
                    <b>כל הערוצים</b>
                  </label>
                  {channels.map((c) => {
                    const on = selected === null || selected.has(c.channel);
                    return (
                      <label key={c.channel} className="rpt-mt-filter-opt">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggleChannel(c.channel)}
                        />
                        {chLabel(c.channel)}
                      </label>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <div className="rpt-ch-table-wrap">
        <table className="rpt-ch-table">
          <thead>
            <tr>
              <Th k="channel" label="ערוץ" />
              {!isMonth && <Th k="budget" label="תקציב" />}
              <Th k="spend" label="עלות" />
              <Th k="leads" label="לידים" />
              <Th k="cpl" label="עלות לליד" />
              <Th k="r1" label="המרה לתיאום" />
              <Th k="scheduled" label="תיאומים" />
              <Th k="cps" label="עלות לתיאום" />
              <Th k="r2" label="המרה לביצוע" />
              <Th k="meetings" label="ביצועים" />
              <Th k="cpm" label="עלות לביצוע" />
              {!isMonth && <Th k="daily" label="קצב יומי" />}
            </tr>
          </thead>
          <tbody>
            {visible.map((c) => {
              const subs = c.subCampaigns.filter((s) => s.name);
              const dot = STATUS_DOT[c.campaignStatus];
              // For Google, pick the campaign-kind-split daily series so
              // discovery and non-discovery rows get DISTINCT trends
              // (data.daily.google is the COMBINED series — showing it on
              // both rows made them identical). A discovery-labelled row →
              // discovery series. A non-discovery google row → the
              // search-only series WHEN discovery is a separate row (the
              // two rows then partition google cleanly, e.g. אנדה's
              // "google" + "Google-discovery"); otherwise a lone "google"
              // row keeps the combined all-google series.
              const gk = data.dailyGoogleByKind;
              const trendSource =
                c.platform === "google"
                  ? gk && GOOGLE_DISCOVERY_LABEL_RE.test(c.channel)
                    ? gk.discovery
                    : gk && hasGoogleDiscovery
                      ? gk.search
                      : (data.daily?.google ?? [])
                  : (data.daily?.facebook ?? []);
              const trendDaily =
                (c.platform === "google" || c.platform === "facebook") &&
                c.spend > 0
                  ? windowDaily(
                      trendSource,
                      data.window.startIso,
                      data.window.endIso,
                    )
                  : [];
              const chipDiffers =
                datesIrregular &&
                c.startIso &&
                c.endIso &&
                (c.startIso !== data.window.startIso ||
                  c.endIso !== data.window.endIso);
              const pacing = isMonth
                ? null
                : computeChannelPacing(c);
              const gapStillOff =
                pacing?.action === "lower" || pacing?.action === "raise";
              const paceKey = pacingChannelKey(data.slug, c.channel);
              const fade = fadeStateOf(
                pacingDismissals[paceKey],
                today,
                localDismiss[paceKey],
                !!gapStillOff,
              );
              const chKey = c.channel.toLowerCase();
              return (
                <tr key={c.channel}>
                  <td
                    className={
                      "rpt-ch-name" +
                      (trendDaily.length >= 2 ? " has-trend" : "")
                    }
                  >
                    <span className="rpt-ch-label">{chLabel(c.channel)}</span>
                    {dot && (
                      <span
                        className={`rpt-ch-dot ${dot.cls}`}
                        title={dot.title}
                      />
                    )}
                    {subs.length > 1 && (
                      <span
                        className="rpt-ch-subs"
                        title={subs
                          .map(
                            (s) =>
                              `${s.name}: ${fmtILS(s.spend)} · ${fmtInt(s.leads)} לידים`,
                          )
                          .join("\n")}
                      >
                        ({subs.length})
                      </span>
                    )}
                    {chipDiffers && (
                      <button
                        type="button"
                        className={
                          "rpt-ch-datechip" +
                          (ganttFor === chKey ? " is-open" : "")
                        }
                        title="חלון התאריכים של הערוץ — לחצו לתרשים"
                        onClick={() =>
                          setGanttFor((cur) => (cur === chKey ? null : chKey))
                        }
                      >
                        📅 {fmtDateHe(c.startIso).slice(0, 5)}–
                        {fmtDateHe(c.endIso).slice(0, 5)}
                      </button>
                    )}
                    {trendDaily.length >= 2 && (
                      <ChannelTrendPop channel={c.channel} series={trendDaily} />
                    )}
                  </td>
                  {!isMonth && (
                    <td
                      className="rpt-budcell rpt-money-cell"
                      style={spanBar(c.budget, c.spend, 0, 0.5, pacing?.cls ?? "")}
                    >
                      {canEditBudget && data.tabSlug ? (
                        <BudgetCell
                          tabSlug={data.tabSlug}
                          channel={c.channel}
                          budget={c.budget}
                          distribute={subs.length > 1}
                        />
                      ) : (
                        fmtILS(c.budget)
                      )}
                    </td>
                  )}
                  <td
                    className="rpt-money-cell"
                    style={
                      isMonth
                        ? undefined
                        : spanBar(c.budget, c.spend, 0.5, 1, pacing?.cls ?? "")
                    }
                  >
                    {fmtILS(c.spend)}
                  </td>
                  <td>{fmtInt(c.leads)}</td>
                  <td style={costHeatStyle("costPerLead", c.costPerLead)}>
                    {c.costPerLead > 0 ? fmtILS(c.costPerLead) : "—"}
                  </td>
                  <ConvCell r={r1Of(c)} />
                  <td>{fmtInt(c.scheduled)}</td>
                  <td
                    style={costHeatStyle("costPerScheduled", c.costPerScheduled)}
                  >
                    {c.costPerScheduled > 0 ? fmtILS(c.costPerScheduled) : "—"}
                  </td>
                  <ConvCell r={r2Of(c)} />
                  <td>{fmtInt(c.meetings)}</td>
                  <td style={costHeatStyle("costPerMeeting", c.costPerMeeting)}>
                    {c.costPerMeeting > 0 ? fmtILS(c.costPerMeeting) : "—"}
                  </td>
                  {!isMonth && (
                    <td
                      className={
                        "rpt-pace" +
                        (pacing?.cls ? ` ${pacing.cls}` : "") +
                        (fade === "dismissed" ? " is-handled" : "")
                      }
                      title={pacing?.lines.join("\n") || undefined}
                    >
                      {fade === "dismissed" && (
                        <span className="rpt-pace-mark" title="טופל">
                          ✓
                        </span>
                      )}
                      {gapStillOff && fade !== "dismissed" && (
                        <span
                          className="rpt-pace-alert"
                          title="התקציב היומי בפלטפורמה לא תואם את הנדרש — נדרש עדכון"
                        >
                          ⚠️
                        </span>
                      )}
                      <span className="rpt-pace-num">
                        {c.dailyRate ? fmtILS(c.dailyRate) : "—"}
                      </span>
                      {pacing?.action === "lower" && (
                        <span className="rpt-pace-action" aria-label="הורד תקציב"> ⬇</span>
                      )}
                      {pacing?.action === "raise" && (
                        <span className="rpt-pace-action" aria-label="העלה תקציב"> ⬆</span>
                      )}
                      {pacing?.action === "investigate" && (
                        <span className="rpt-pace-action" aria-label="בדוק delivery"> 🔍</span>
                      )}
                      {gapStillOff && fade !== "dismissed" && (
                        <button
                          type="button"
                          className="rpt-pace-btn"
                          title="טיפלתי — שקט עד מחר; אם עדיין יישאר פער בין התקציב המוגדר לנדרש, ההתראה תחזור מחר"
                          onClick={() => dismissPacing(c, false)}
                        >
                          ✓{fade === "resurfaced" ? " (חזר)" : ""}
                        </button>
                      )}
                      {fade === "dismissed" && (
                        <button
                          type="button"
                          className="rpt-pace-btn"
                          title="בטל טיפול"
                          onClick={() => dismissPacing(c, true)}
                        >
                          ↩︎
                        </button>
                      )}
                      {canEditBudget &&
                        c.dailyRate > 0 &&
                        (() => {
                          const url =
                            c.platform === "google"
                              ? adLinks?.gAdsUrl
                              : c.platform === "facebook"
                                ? adLinks?.fbAdsUrl
                                : "";
                          if (!url) return null;
                          const openUrl =
                            c.platform === "google"
                              ? `${url}${url.includes("#") ? "" : `#fandf-filter=${encodeURIComponent(data.slug)}`}`
                              : url;
                          return (
                            <CopyAmountButton
                              amount={String(Math.round(c.dailyRate))}
                              // Google: copy the slug too, so it can be pasted
                              // into Google Ads' own search (its URL can't
                              // pre-filter). FB: the fbAdsUrl already filters by
                              // the project slug, so the clipboard only needs
                              // the number — no slug (matches BudgetGrid).
                              copyId={
                                c.platform === "facebook" ? undefined : data.slug
                              }
                              url={openUrl}
                              variant="ghost"
                              label="⧉"
                            />
                          );
                        })()}
                    </td>
                  )}
                </tr>
              );
            })}
            <tr className="rpt-ch-totals">
              <td>
                <b>סה״כ</b>
              </td>
              {!isMonth && (
                <td>
                  <b>{fmtILS(totals.budget)}</b>
                </td>
              )}
              <td>
                <b>{fmtILS(totals.spend)}</b>
              </td>
              <td>
                <b>{fmtInt(totals.leads)}</b>
              </td>
              <td style={costHeatStyle("costPerLead", tCpl)}>
                <b>{tCpl > 0 ? fmtILS(tCpl) : "—"}</b>
              </td>
              <ConvCell r={tR1} />
              <td>
                <b>{fmtInt(totals.scheduled)}</b>
              </td>
              <td style={costHeatStyle("costPerScheduled", tCps)}>
                <b>{tCps > 0 ? fmtILS(tCps) : "—"}</b>
              </td>
              <ConvCell r={tR2} />
              <td>
                <b>{fmtInt(totals.meetings)}</b>
              </td>
              <td style={costHeatStyle("costPerMeeting", tCpm)}>
                <b>{tCpm > 0 ? fmtILS(tCpm) : "—"}</b>
              </td>
              {!isMonth && (
                <td>
                  <b>{totals.daily ? fmtILS(totals.daily) : "—"}</b>
                </td>
              )}
            </tr>
          </tbody>
        </table>
      </div>

      <ReportChannelCharts channels={channels} />
    </div>
  );
}
